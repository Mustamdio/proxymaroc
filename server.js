const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ربط ملفات الواجهة الأمامية (Frontend) من مجلد public
app.use(express.static(__dirname));

// الاتصال بقاعدة بيانات MongoDB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/proxy-store";
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB successfully"))
    .catch(err => console.error("MongoDB connection error:", err));

// ==================== النماذج (Models) ====================

// 1. نموذج الأماكن والمخزون (Pools 1 to 8)
const poolSchema = new mongoose.Schema({
    poolNumber: { type: Number, required: true, unique: true }, // رقم المكان (1 إلى 8)
    ips: [{ 
        ipAddress: String, 
        isUsed: { type: Boolean, default: false } 
    }],
    version: { type: Number, default: 1 } // رقم النسخة للإشعارات
});
const Pool = mongoose.model('Pool', poolSchema);

// 2. نموذج المستخدمين (Users)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    selectedPack: { type: Number, default: 0 }, // عدد الأيبيهات المختارة (مثلاً 400)
    assignedPool: { type: Number, default: null }, // المكان الذي سُحبت منه الأيبيهات
    assignedIps: [String], // أرشيف الأيبيهات الخاصة بهذا المستخدم
    poolVersionWhenAssigned: { type: Number, default: 1 },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);


// ==================== المسارات (API Routes) ====================

// أ. مسار التسجيل السريع (Username & Password فقط)
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, packSize } = req.body;
        
        // التحقق هل الاسم موجود مسبقاً
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "اسم المستخدم مستخدم مسبقاً، اختر اسمآ آخر." });
        }

        // إنشاء المستخدم الجديد
        const newUser = new User({
            username,
            password,
            selectedPack: packSize ? parseInt(packSize) : 0
        });
        await newUser.save();

        res.json({ success: true, message: "تم التسجيل بنجاح!", userId: newUser._id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ب. مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        
        if (!user) {
            return res.status(400).json({ success: false, message: "اسم المستخدم أو كلمة المرور غير صحيحة." });
        }

        res.json({ success: true, userId: user._id, isAdmin: username === 'admin' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ج. جلب بيانات لوحة تحكم المستخدم
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

        // التحقق مما إذا تم تحديث المكان الذي ينتمي إليه العضو (لتنبيهه)
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

// د. عملية الشراء وتوزيع الأيبيهات تلقائياً من الأماكن (من 1 إلى 8)
app.post('/api/buy/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

        const requestedCount = user.selectedPack;
        if (!requestedCount || requestedCount <= 0) {
            return res.status(400).json({ success: false, message: "لم تقم بتحديد أي باقة للشراء." });
        }

        // البحث في الأماكن بالترتيب من 1 إلى 8 عن مكان فيه أيبيهات كافية وغير مستخدمة
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
            return res.status(400).json({ success: false, message: "عذراً، جميع الأماكن فارغة أو لا توجد كمية كافية حالياً. يرجى الانتظار ريثما يتم شحن أيبيهات جديدة." });
        }

        // تحديد الأيبيهات كمستخدمة في ذلك المكان
        for (let ipObj of availableIps) {
            ipObj.isUsed = true;
        }
        await targetPool.save();

        // حفظ الأيبيهات في أرشيف العضو
        user.assignedIps = availableIps.map(i => i.ipAddress);
        user.assignedPool = targetPool.poolNumber;
        user.poolVersionWhenAssigned = targetPool.version;
        user.paymentStatus = 'paid'; // افتراضياً (أو تتركه pending إذا كنت ستؤكد يدوياً)
        await user.save();

        res.json({ success: true, message: "تمت عملية الشراء بنجاح! يمكنك تحميل ملف الأيبيهات الآن." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// هـ. تحميل ملف الأيبيهات `.txt`
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

// 1. جلب جميع المستخدمين والأماكن للأدمن
app.get('/api/admin/data', async (req, res) => {
    try {
        const users = await User.find({ username: { $ne: 'admin' } });
        const pools = await Pool.find().sort({ poolNumber: 1 });
        res.json({ success: true, users, pools });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. التحكم في المستخدمين (توقيف، مسح، تغيير الباقة)
app.post('/api/admin/user-action', async (req, res) => {
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

// 3. إعادة تحميل/شحن الأيبيهات في مكان معين (Pool Restock) وتحديث النسخة
app.post('/api/admin/restock-pool', async (req, res) => {
    try {
        const { poolNumber, ipsText } = req.body; // ipsText: الأيبيهات مفصولة بأسطر جديدة
        
        // تحويل النص إلى مصفوفة أيبيهات جديدة
        const ipList = ipsText.split('\n')
            .map(ip => ip.trim())
            .filter(ip => ip.length > 0)
            .map(ipAddress => ({ ipAddress, isUsed: false }));

        let pool = await Pool.findOne({ poolNumber });
        
        if (!pool) {
            // إنشاء المكان إذا لم يكن موجوداً
            pool = new Pool({
                poolNumber,
                ips: ipList,
                version: 1
            });
        } else {
            // تحديث الأيبيهات وزيادة رقم النسخة ليظهر تنبيه للعملاء القدامى
            pool.ips = ipList;
            pool.version += 1;
        }

        await pool.save();
        res.json({ success: true, message: `تم شحن المكان رقم ${poolNumber} بنجاح وزيادة النسخة!` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
