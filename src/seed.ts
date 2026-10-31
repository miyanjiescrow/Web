import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './lib/firebase';

const seedAds = async () => {
  const ads = [
    {
      title: 'طراحی لوگو و هویت بصری حرفه‌ای',
      price: 2500000,
      category: 'freelance',
      description: 'طراحی تخصصی لوگو برای استارتاپ‌ها و کسب‌وکارهای نوپا با بالاترین کیفیت.',
      imageUrl: '/src/assets/images/creative_design_work_1793474039218.jpg',
      sellerId: 'user_A',
      sellerName: 'امین راد',
      createdAt: serverTimestamp(),
    },
    {
      title: 'آیفون ۱۳ پرو - ۲۵۶ گیگ - مشابه نو',
      price: 45000000,
      category: 'digital',
      description: 'در حد نو، بدون خط و خش، با گارانتی فعال و لوازم کامل.',
      imageUrl: '/src/assets/images/digital_gadget_showcase_1793474038881.jpg',
      sellerId: 'user_B',
      sellerName: 'رضا علوی',
      createdAt: serverTimestamp(),
    },
    {
      title: 'برنامه‌نویسی پنل مدیریتی با React',
      price: 12000000,
      category: 'freelance',
      description: 'پیاده‌سازی داشبوردهای مدیریتی مدرن و ریسپانسیو با آخرین تکنولوژی‌ها.',
      imageUrl: '/src/assets/images/freelance_service_setup_1793474039406.jpg',
      sellerId: 'user_C',
      sellerName: 'سارا کریمی',
      createdAt: serverTimestamp(),
    }
  ];

  for (const ad of ads) {
    await addDoc(collection(db, 'ads'), ad);
  }
  console.log('Seeded marketplace ads');
};

seedAds();
