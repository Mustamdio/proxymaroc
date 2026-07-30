const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إعداد الجلسات (Sessions)
app.use(session({
    secret: process.env.SESSION_SECRET || 'proxy-store-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // جلسة تدوم لمدة يوم كامل
}));

// ربط ملفات الواجهة الأمامية (Frontend) من المجلد الحالي
app.use(express.static(__dirname));

// الاتصال بقاعدة بيانات MongoDB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/proxy-store";
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB successfully"))
    .catch(err => console.error("MongoDB connection error:", err));

// ==================== النماذج (Models) ====================

const poolSchema = new mongoose.Schema({
    poolNumber: { type: Number, required: true, unique: true },
    ips: [{ 
        ipAddress: String, 
        isUsed: { type: Boolean, default: false } 
    }],
    version: { type: Number, default: 1 }
});
const Pool = mongoose.model('Pool', poolSchema);

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    selectedPack: { type: Number, default: 0 },
    assignedPool: { type: Number, default: null },
    assignedIps: [String],
    poolVersionWhenAssigned: { type: Number, default: 1 },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);


// ==================== مسار تسجيل الخروج (Logout) ====================
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        // مسح الكوكي نهائياً مع تحديد المسار لمنع بقاء الجلسة معلقة
        res.clearCookie('connect.sid', { path: '/', httpOnly: true, secure: false }); 
        // منع المتصفح من عمل Cache للصفحة المحمية بعد الخروج
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.redirect('/index.html'); 
    });
});


// ==================== المسارات (API Routes) ====================

app.post('/api/register', async (req, res) => {
    try {
        const { username, password, packSize } = req.body;
        
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "اسم المستخدم مستخدم مسبقاً، اختر اسماً آخر." });
        }

        const newUser = new User({
            username,
            password,
            isAdmin: false, 
            selectedPack: packSize ? parseInt(packSize) : 0
        });
        await newUser.save();

        res.json({ success: true, message: "تم التسجيل بنجاح وتخزينه في القاعدة!", userId: newUser._id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        
        if (!user) {
            return res.status(400).json({ success: false, message: "اسم المستخدم أو كلمة المرور غير صحيحة." });
        }

        // تخزين المستخدم في الجلسة
        req.session.user = {
            id: user._id,
            username: user.username,
            isAdmin: user.isAdmin
        };

        res.json({ 
            success: true, 
            userId: user._id, 
            isAdmin: user.isAdmin 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// مسارات النماذج التقليدية (Forms)
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).send("اسم المستخدم مستخدم مسبقاً.");
        }
        const newUser = new User({ username, password, isAdmin: false });
        await newUser.save();
        
        req.session.user = { id: newUser._id, username: newUser.username, isAdmin: newUser.isAdmin };
        res.redirect(`/dashboard.html?id=${newUser._id}`);
    } catch (err) {
        res.status(500).send("خطأ في التسجيل: " + err.message);
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) {
            return res.status(400).send("بيانات الدخول غير صحيحة.");
        }

        req.session.user = {
            id: user._id,
            username: user.username,
            isAdmin: user.isAdmin
        };

        if (user.isAdmin) {
            return res.redirect('/admin.html');
        }
        res.redirect(`/dashboard.html?id=${user._id}`);
    } catch (err) {
        res.status(500).send("خطأ في تسجيل الدخول: " + err.message);
    }
});

app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

        let needsUpdate = false;
        if (user.assignedPool) {
            const pool = await Pool.findOne({ poolNumber: user.assignedPool });
            if (pool && pool.version > user.poolVersionWhenAssigned) {
                needsUpdate = true;
            }
        }

        res.json({ success: true, user, needsUpdate });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/buy/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

        const requestedCount = user.selectedPack;
        if (!requestedCount || requestedCount <= 0) {
            return res.status(400).json({ success: false, message: "لم تقم بتحديد أي باقة للشراء." });
        }

        let pools = await Pool.find().sort({ poolNumber: 1 });
        let targetPool = null;
        let availableIps = [];

        for (let pool of pools) {
            let unusedIps = pool.ips.filter(ip => !ip.isUsed);
            if (unusedIps.length >= requestedCount) {
                targetPool = pool;
                availableIps = unusedIps.slice(0, requestedCount);
                break;
            }
        }

        if (!targetPool) {
            return res.status(400).json({ success: false, message: "عذراً، جميع الأماكن فارغة أو لا توجد كمية كافية حالياً." });
        }

        for (let ipObj of availableIps) {
            ipObj.isUsed = true;
        }
        await targetPool.save();

        user.assignedIps = availableIps.map(i => i.ipAddress);
        user.assignedPool = targetPool.poolNumber;
        user.poolVersionWhenAssigned = targetPool.version;
        user.paymentStatus = 'paid'; 
        await user.save();

        res.json({ success: true, message: "تمت عملية الشراء بنجاح! يمكنك تحميل ملف الأيبيهات الآن." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/download-ips/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user || user.assignedIps.length === 0) {
            return res.status(404).send("لا توجد أيبيهات متاحة للتحميل.");
        }

        const fileContent = user.assignedIps.join('\n');
        
        res.setHeader('Content-disposition', `attachment; filename=proxies_${user.username}.txt`);
        res.setHeader('Content-Type', 'text/plain');
        res.send(fileContent);
    } catch (error) {
        res.status(500).send("حدث خطأ أثناء تحميل الملف.");
    }
});


// ==================== لوحة تحكم الأدمن (Admin APIs) ====================

// Middleware للتأكد واش المستخدم Admin بصح عبر الجلسة
function isAdminAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.isAdmin === true) {
        return next(); 
    }
    // إذا لم يكن مشرفاً، قم بإرجاعه لصفحة البداية أو خطأ في الـ API
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(403).json({ success: false, message: "غير مصرح لك بالوصول" });
    }
    res.redirect('/index.html'); 
}

app.get('/api/admin/data', isAdminAuth, async (req, res) => {
    try {
        const users = await User.find({ isAdmin: false });
        const pools = await Pool.find().sort({ poolNumber: 1 });
        res.json({ success: true, users, pools });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/user-action', isAdminAuth, async (req, res) => {
    try {
        const { userId, action, newPack } = req.body;
        
        if (action === 'delete') {
            await User.findByIdAndDelete(userId);
            return res.json({ success: true, message: "تم مسح العضو بنجاح." });
        }
        
        if (action === 'toggle-status') {
            const user = await User.findById(userId);
            user.status = user.status === 'active' ? 'banned' : 'active';
            await user.save();
            return res.json({ success: true, message: "تم تغيير حالة العضو." });
        }

        if (action === 'change-pack') {
            const user = await User.findById(userId);
            user.selectedPack = parseInt(newPack);
            await user.save();
            return res.json({ success: true, message: "تم تحديث باقة العضو بنجاح." });
        }

        res.status(400).json({ success: false, message: "إجراء غير معروف." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/restock-pool', isAdminAuth, async (req, res) => {
    try {
        const { poolNumber, ipsText } = req.body; 
        
        const ipList = ipsText.split('\n')
            .map(ip => ip.trim())
            .filter(ip => ip.length > 0)
            .map(ipAddress => ({ ipAddress, isUsed: false }));

        let pool = await Pool.findOne({ poolNumber });
        
        if (!pool) {
            pool = new Pool({
                poolNumber,
                ips: ipList,
                version: 1
            });
        } else {
            pool.ips = ipList;
            pool.version += 1;
        }

        await pool.save();
        res.json({ success: true, message: `تم شحن المكان رقم ${poolNumber} بنجاح وزيادة النسخة!` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// حماية مسار صفحة الأدمن بالكامل وإرجاع الملف من الجذر الرئيسي
app.get('/admin.html', isAdminAuth, (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
