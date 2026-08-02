const mongoose = require('mongoose');

const pageContentSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: [true, 'স্লাগ দিন'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  title: {
    type: String,
    required: [true, 'শিরোনাম দিন'],
    trim: true,
  },
  titleBn: {
    type: String,
    required: [true, 'বাংলা শিরোনাম দিন'],
    trim: true,
  },
  content: {
    type: String,
    required: [true, 'কন্টেন্ট দিন'],
  },
  contentBn: {
    type: String,
    required: [true, 'বাংলা কন্টেন্ট দিন'],
  },
  metaDescription: {
    type: String,
    trim: true,
  },
  metaDescriptionBn: {
    type: String,
    trim: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
}, {
  timestamps: true,
});

// Indexes

// Static: Get page by slug
pageContentSchema.statics.getBySlug = function(slug) {
  return this.findOne({ slug, isActive: true });
};

// Static: Seed default pages
pageContentSchema.statics.seedDefaults = async function() {
  const defaultPages = [
    {
      slug: 'privacy-policy',
      title: 'Privacy Policy',
      titleBn: 'গোপনীয়তা নীতি',
      metaDescription: 'Hisaab Privacy Policy - Learn how we protect your data',
      metaDescriptionBn: 'হিসাব গোপনীয়তা নীতি - আমরা কিভাবে আপনার তথ্য সুরক্ষিত রাখি',
      content: `# Privacy Policy

**Last Updated: January 2026**

## Introduction
Hisaab ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our shop management platform.

## Information We Collect

### Personal Information
- Name and contact details (phone number, email)
- Shop information (name, address, business type)
- Transaction data (sales, purchases, customer records)

### Automatically Collected Information
- Device information and IP address
- Usage patterns and analytics
- Browser type and settings

## How We Use Your Information
- To provide and maintain our services
- To process transactions and send notifications
- To improve our platform and user experience
- To communicate important updates
- To provide customer support

## Data Security
We implement industry-standard security measures to protect your data, including:
- Encrypted data transmission (SSL/TLS)
- Secure server infrastructure
- Regular security audits
- Access controls and authentication

## Data Retention
We retain your data for as long as your account is active or as needed to provide services. You may request data deletion at any time.

## Your Rights
You have the right to:
- Access your personal data
- Correct inaccurate data
- Request data deletion
- Export your data

## Contact Us
For privacy-related inquiries, contact us at:
- Phone: 01757995016
- Email: support@hisaab.app`,
      contentBn: `# গোপনীয়তা নীতি

**সর্বশেষ আপডেট: জানুয়ারি ২০২৬**

## ভূমিকা
হিসাব ("আমরা", "আমাদের") আপনার গোপনীয়তা রক্ষায় প্রতিশ্রুতিবদ্ধ। এই গোপনীয়তা নীতিতে ব্যাখ্যা করা হয়েছে যে আমরা কিভাবে আপনার তথ্য সংগ্রহ, ব্যবহার এবং সুরক্ষিত রাখি।

## আমরা যে তথ্য সংগ্রহ করি

### ব্যক্তিগত তথ্য
- নাম ও যোগাযোগের তথ্য (ফোন নম্বর, ইমেইল)
- দোকানের তথ্য (নাম, ঠিকানা, ব্যবসার ধরন)
- লেনদেনের তথ্য (বিক্রয়, ক্রয়, কাস্টমার রেকর্ড)

### স্বয়ংক্রিয়ভাবে সংগৃহীত তথ্য
- ডিভাইস তথ্য ও আইপি ঠিকানা
- ব্যবহারের ধরন ও বিশ্লেষণ
- ব্রাউজারের ধরন ও সেটিংস

## আমরা কিভাবে আপনার তথ্য ব্যবহার করি
- আমাদের সেবা প্রদান ও রক্ষণাবেক্ষণ করতে
- লেনদেন প্রক্রিয়াকরণ ও বিজ্ঞপ্তি পাঠাতে
- আমাদের প্ল্যাটফর্ম ও ব্যবহারকারীর অভিজ্ঞতা উন্নত করতে
- গুরুত্বপূর্ণ আপডেট জানাতে
- কাস্টমার সাপোর্ট প্রদান করতে

## তথ্য সুরক্ষা
আমরা আপনার তথ্য সুরক্ষিত রাখতে শিল্প-মানের নিরাপত্তা ব্যবস্থা ব্যবহার করি, যেমন:
- এনক্রিপ্টেড ডেটা ট্রান্সমিশন (SSL/TLS)
- সুরক্ষিত সার্ভার অবকাঠামো
- নিয়মিত নিরাপত্তা অডিট
- অ্যাক্সেস নিয়ন্ত্রণ ও প্রমাণীকরণ

## তথ্য সংরক্ষণ
আপনার অ্যাকাউন্ট সক্রিয় থাকা বা সেবা প্রদানের জন্য প্রয়োজনীয় সময় পর্যন্ত আমরা আপনার তথ্য সংরক্ষণ করি। আপনি যেকোনো সময় তথ্য মুছে ফেলার অনুরোধ করতে পারেন।

## আপনার অধিকার
আপনার অধিকার রয়েছে:
- আপনার ব্যক্তিগত তথ্য অ্যাক্সেস করা
- ভুল তথ্য সংশোধন করা
- তথ্য মুছে ফেলার অনুরোধ করা
- আপনার তথ্য এক্সপোর্ট করা

## যোগাযোগ
গোপনীয়তা সংক্রান্ত জিজ্ঞাসার জন্য যোগাযোগ করুন:
- ফোন: ০১৭৫৭৯৯৫০১৬
- ইমেইল: support@hisaab.app`,
    },
    {
      slug: 'terms-of-service',
      title: 'Terms of Service',
      titleBn: 'সেবার শর্তাবলী',
      metaDescription: 'Hisaab Terms of Service - Rules and guidelines for using our platform',
      metaDescriptionBn: 'হিসাব সেবার শর্তাবলী - আমাদের প্ল্যাটফর্ম ব্যবহারের নিয়ম ও নির্দেশিকা',
      content: `# Terms of Service

**Last Updated: January 2026**

## 1. Agreement to Terms
By accessing or using Hisaab, you agree to be bound by these Terms of Service. If you do not agree, please do not use our services.

## 2. Description of Service
Hisaab is a comprehensive shop management platform that provides:
- Point of Sale (POS) system
- Inventory management
- Customer management
- Sales and purchase tracking
- Financial reporting
- SMS notifications

## 3. Account Registration
- You must provide accurate and complete information
- You are responsible for maintaining account security
- One shop per account unless otherwise authorized
- You must be 18 years or older to use our services

## 4. Subscription and Payment
- Free trial period as specified during registration
- Subscription fees are billed according to your chosen plan
- Payments are non-refundable except as required by law
- We reserve the right to modify pricing with notice

## 5. Acceptable Use
You agree NOT to:
- Use the service for illegal purposes
- Attempt to hack or compromise our systems
- Share your account credentials
- Upload malicious content or software
- Violate any applicable laws

## 6. Data Ownership
- You retain ownership of your business data
- We have the right to use anonymized data for improvements
- You grant us license to process your data to provide services

## 7. Service Availability
- We strive for 99.9% uptime but cannot guarantee uninterrupted service
- Scheduled maintenance will be communicated in advance
- We are not liable for downtime beyond our control

## 8. Limitation of Liability
Hisaab shall not be liable for:
- Indirect or consequential damages
- Loss of profits or data
- Third-party actions

## 9. Termination
We may suspend or terminate accounts that violate these terms. You may cancel your account at any time.

## 10. Contact
For questions about these terms:
- Phone: 01757995016
- Email: support@hisaab.app`,
      contentBn: `# সেবার শর্তাবলী

**সর্বশেষ আপডেট: জানুয়ারি ২০২৬**

## ১. শর্তাবলীতে সম্মতি
হিসাব ব্যবহার করে আপনি এই সেবার শর্তাবলী মেনে চলতে সম্মত হচ্ছেন। যদি সম্মত না হন, অনুগ্রহ করে আমাদের সেবা ব্যবহার করবেন না।

## ২. সেবার বিবরণ
হিসাব একটি সম্পূর্ণ দোকান ব্যবস্থাপনা প্ল্যাটফর্ম যা প্রদান করে:
- পয়েন্ট অফ সেল (POS) সিস্টেম
- ইনভেন্টরি ব্যবস্থাপনা
- কাস্টমার ব্যবস্থাপনা
- বিক্রয় ও ক্রয় ট্র্যাকিং
- আর্থিক রিপোর্ট
- এসএমএস নোটিফিকেশন

## ৩. অ্যাকাউন্ট নিবন্ধন
- আপনাকে সঠিক ও সম্পূর্ণ তথ্য প্রদান করতে হবে
- অ্যাকাউন্ট নিরাপত্তা রক্ষা আপনার দায়িত্ব
- বিশেষ অনুমতি ছাড়া প্রতি অ্যাকাউন্টে একটি দোকান
- আমাদের সেবা ব্যবহারের জন্য আপনার বয়স ১৮ বছর বা তার বেশি হতে হবে

## ৪. সাবস্ক্রিপশন ও পেমেন্ট
- নিবন্ধনের সময় উল্লিখিত বিনামূল্যে ট্রায়াল সময়কাল
- আপনার নির্বাচিত প্ল্যান অনুযায়ী সাবস্ক্রিপশন ফি বিল করা হবে
- আইন দ্বারা প্রয়োজন না হলে পেমেন্ট ফেরতযোগ্য নয়
- আমরা নোটিশ সহ মূল্য পরিবর্তনের অধিকার সংরক্ষণ করি

## ৫. গ্রহণযোগ্য ব্যবহার
আপনি সম্মত হচ্ছেন যে আপনি করবেন না:
- অবৈধ উদ্দেশ্যে সেবা ব্যবহার
- আমাদের সিস্টেম হ্যাক বা আপস করার চেষ্টা
- আপনার অ্যাকাউন্ট তথ্য শেয়ার
- ক্ষতিকর কন্টেন্ট বা সফটওয়্যার আপলোড
- কোনো প্রযোজ্য আইন লঙ্ঘন

## ৬. তথ্যের মালিকানা
- আপনার ব্যবসায়িক তথ্যের মালিকানা আপনার
- উন্নতির জন্য পরিচয়হীন তথ্য ব্যবহারের অধিকার আমাদের আছে
- সেবা প্রদানের জন্য আপনার তথ্য প্রক্রিয়া করার লাইসেন্স আপনি আমাদের দিচ্ছেন

## ৭. সেবা উপলব্ধতা
- আমরা ৯৯.৯% আপটাইমের জন্য চেষ্টা করি কিন্তু নিরবচ্ছিন্ন সেবার গ্যারান্টি দিতে পারি না
- নির্ধারিত রক্ষণাবেক্ষণ আগে থেকে জানানো হবে
- আমাদের নিয়ন্ত্রণের বাইরে ডাউনটাইমের জন্য আমরা দায়ী নই

## ৮. দায়বদ্ধতার সীমাবদ্ধতা
হিসাব দায়ী থাকবে না:
- পরোক্ষ বা ফলস্বরূপ ক্ষতির জন্য
- লাভ বা তথ্য হারানোর জন্য
- তৃতীয় পক্ষের কার্যক্রমের জন্য

## ৯. সমাপ্তি
এই শর্তাবলী লঙ্ঘনকারী অ্যাকাউন্ট আমরা স্থগিত বা বন্ধ করতে পারি। আপনি যেকোনো সময় আপনার অ্যাকাউন্ট বাতিল করতে পারেন।

## ১০. যোগাযোগ
এই শর্তাবলী সম্পর্কে প্রশ্নের জন্য:
- ফোন: ০১৭৫৭৯৯৫০১৬
- ইমেইল: support@hisaab.app`,
    },
    {
      slug: 'refund-policy',
      title: 'Refund Policy',
      titleBn: 'ফেরত নীতি',
      metaDescription: 'Hisaab Refund Policy - Our subscription refund guidelines',
      metaDescriptionBn: 'হিসাব ফেরত নীতি - আমাদের সাবস্ক্রিপশন ফেরতের নির্দেশিকা',
      content: `# Refund Policy

**Last Updated: January 2026**

## Free Trial
Hisaab offers a free trial period for all new users. During this period, you can explore all features without any payment.

## Subscription Refunds

### Within 7 Days
If you are not satisfied with our service, you may request a full refund within 7 days of your first paid subscription. This applies to first-time subscribers only.

### After 7 Days
Subscription fees paid after the 7-day period are generally non-refundable. However, we may consider refunds on a case-by-case basis for:
- Technical issues preventing service use
- Billing errors
- Service discontinuation by Hisaab

## How to Request a Refund
1. Contact our support team
2. Provide your account details and reason for refund
3. Allow 3-5 business days for review
4. Approved refunds will be processed within 7-10 business days

## Contact
- Phone: 01757995016
- Email: support@hisaab.app`,
      contentBn: `# ফেরত নীতি

**সর্বশেষ আপডেট: জানুয়ারি ২০২৬**

## বিনামূল্যে ট্রায়াল
হিসাব সব নতুন ব্যবহারকারীদের জন্য বিনামূল্যে ট্রায়াল সময়কাল অফার করে। এই সময়ে, আপনি কোনো পেমেন্ট ছাড়াই সব ফিচার অন্বেষণ করতে পারবেন।

## সাবস্ক্রিপশন ফেরত

### ৭ দিনের মধ্যে
আপনি যদি আমাদের সেবায় সন্তুষ্ট না হন, আপনার প্রথম পেইড সাবস্ক্রিপশনের ৭ দিনের মধ্যে সম্পূর্ণ ফেরতের অনুরোধ করতে পারেন। এটি শুধুমাত্র প্রথমবারের সাবস্ক্রাইবারদের জন্য প্রযোজ্য।

### ৭ দিনের পরে
৭ দিনের সময়কালের পরে প্রদত্ত সাবস্ক্রিপশন ফি সাধারণত ফেরতযোগ্য নয়। তবে, আমরা নিম্নলিখিত ক্ষেত্রে কেস-বাই-কেস ভিত্তিতে ফেরত বিবেচনা করতে পারি:
- সেবা ব্যবহারে বাধা সৃষ্টিকারী প্রযুক্তিগত সমস্যা
- বিলিং ত্রুটি
- হিসাব দ্বারা সেবা বন্ধ

## কিভাবে ফেরতের অনুরোধ করবেন
১. আমাদের সাপোর্ট টিমের সাথে যোগাযোগ করুন
২. আপনার অ্যাকাউন্ট বিবরণ ও ফেরতের কারণ জানান
৩. পর্যালোচনার জন্য ৩-৫ কার্যদিবস অপেক্ষা করুন
৪. অনুমোদিত ফেরত ৭-১০ কার্যদিবসের মধ্যে প্রক্রিয়া করা হবে

## যোগাযোগ
- ফোন: ০১৭৫৭৯৯৫০১৬
- ইমেইল: support@hisaab.app`,
    },
    {
      slug: 'about-us',
      title: 'About Us',
      titleBn: 'আমাদের সম্পর্কে',
      metaDescription: 'About Hisaab - Modern shop management solution for Bangladeshi businesses',
      metaDescriptionBn: 'হিসাব সম্পর্কে - বাংলাদেশি ব্যবসার জন্য আধুনিক দোকান ব্যবস্থাপনা সমাধান',
      content: `# About Hisaab

## Our Mission
To empower small and medium businesses in Bangladesh with modern, easy-to-use technology that simplifies their daily operations and helps them grow.

## What is Hisaab?
Hisaab (হিসাব) is a comprehensive shop management platform designed specifically for Bangladeshi businesses. The name "Hisaab" means "calculation" or "accounting" in Bengali, reflecting our core purpose of helping businesses manage their finances and operations efficiently.

## Our Features
- **Point of Sale (POS)**: Fast and intuitive billing system
- **Inventory Management**: Track stock, set alerts, manage products
- **Customer Management**: Maintain customer records and due balances
- **Sales Tracking**: Real-time sales reports and analytics
- **Expense Management**: Track all business expenses
- **SMS Notifications**: Automated customer notifications
- **Reports**: Comprehensive business insights

## Why Choose Hisaab?
- **Bengali First**: Designed with Bengali interface and localization
- **Mobile Friendly**: Works perfectly on all devices
- **Affordable**: Plans designed for small businesses
- **Reliable**: Cloud-based with 99.9% uptime
- **Secure**: Bank-level security for your data
- **Support**: Dedicated local customer support

## Our Team
Hisaab is developed by Md Mainul Hasan and team, passionate about bringing technology solutions to local businesses. We understand the unique challenges faced by Bangladeshi shop owners and have built Hisaab to address those specific needs.

## Contact Us
- Phone: 01757995016
- Email: support@hisaab.app
- Address: Dhaka, Bangladesh`,
      contentBn: `# হিসাব সম্পর্কে

## আমাদের লক্ষ্য
আধুনিক, ব্যবহার-সহজ প্রযুক্তি দিয়ে বাংলাদেশের ছোট ও মাঝারি ব্যবসাগুলোকে শক্তিশালী করা যা তাদের দৈনন্দিন কার্যক্রম সহজ করে এবং তাদের বৃদ্ধিতে সাহায্য করে।

## হিসাব কী?
হিসাব হলো বাংলাদেশি ব্যবসার জন্য বিশেষভাবে ডিজাইন করা একটি সম্পূর্ণ দোকান ব্যবস্থাপনা প্ল্যাটফর্ম। "হিসাব" নামটি আমাদের মূল উদ্দেশ্যকে প্রতিফলিত করে - ব্যবসাগুলোকে তাদের আর্থিক ও কার্যক্রম দক্ষতার সাথে পরিচালনা করতে সাহায্য করা।

## আমাদের ফিচারসমূহ
- **পয়েন্ট অফ সেল (POS)**: দ্রুত ও স্বজ্ঞাত বিলিং সিস্টেম
- **ইনভেন্টরি ব্যবস্থাপনা**: স্টক ট্র্যাক, অ্যালার্ট সেট, পণ্য ব্যবস্থাপনা
- **কাস্টমার ব্যবস্থাপনা**: কাস্টমার রেকর্ড ও বাকি ব্যালেন্স রক্ষণাবেক্ষণ
- **বিক্রয় ট্র্যাকিং**: রিয়েল-টাইম বিক্রয় রিপোর্ট ও বিশ্লেষণ
- **খরচ ব্যবস্থাপনা**: সব ব্যবসায়িক খরচ ট্র্যাক
- **এসএমএস নোটিফিকেশন**: স্বয়ংক্রিয় কাস্টমার বিজ্ঞপ্তি
- **রিপোর্ট**: সম্পূর্ণ ব্যবসায়িক অন্তর্দৃষ্টি

## কেন হিসাব বেছে নেবেন?
- **বাংলা প্রথম**: বাংলা ইন্টারফেস ও স্থানীয়করণ সহ ডিজাইন
- **মোবাইল ফ্রেন্ডলি**: সব ডিভাইসে নিখুঁতভাবে কাজ করে
- **সাশ্রয়ী**: ছোট ব্যবসার জন্য ডিজাইন করা প্ল্যান
- **নির্ভরযোগ্য**: ৯৯.৯% আপটাইম সহ ক্লাউড-ভিত্তিক
- **নিরাপদ**: আপনার তথ্যের জন্য ব্যাংক-স্তরের নিরাপত্তা
- **সাপোর্ট**: নিবেদিত স্থানীয় কাস্টমার সাপোর্ট

## আমাদের টিম
হিসাব তৈরি করেছেন মো. মাইনুল হাসান ও তাঁর টিম, যারা স্থানীয় ব্যবসায় প্রযুক্তি সমাধান আনতে আগ্রহী। আমরা বাংলাদেশি দোকান মালিকদের অনন্য চ্যালেঞ্জগুলো বুঝি এবং সেই নির্দিষ্ট চাহিদাগুলো পূরণ করতে হিসাব তৈরি করেছি।

## যোগাযোগ
- ফোন: ০১৭৫৭৯৯৫০১৬
- ইমেইল: support@hisaab.app
- ঠিকানা: ঢাকা, বাংলাদেশ`,
    },
  ];

  for (const page of defaultPages) {
    const exists = await this.findOne({ slug: page.slug });
    if (!exists) {
      await this.create(page);
      console.log(`Created default page: ${page.slug}`);
    }
  }
};

const PageContent = mongoose.model('PageContent', pageContentSchema);

module.exports = PageContent;
