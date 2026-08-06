/**
 * Category & Subcategory Seed Data
 * Auto-seeded per shop type during onboarding
 *
 * Each category has: name (Bengali by default), icon, order, subcategories[]
 */

// Shorthand for the newer shop types: a list of subcategory names becomes
// [{ name, order }] with 1-based ordering, matching the expanded shape above.
const sub = (names) => names.map((name, index) => ({ name, order: index + 1 }));

const CATEGORY_SEEDS = {
  "cloth": [
    {
      "name": "পুরুষ পোশাক",
      "icon": "shirt",
      "order": 1,
      "subcategories": [
        {
          "name": "শার্ট",
          "order": 1
        },
        {
          "name": "প্যান্ট",
          "order": 2
        },
        {
          "name": "পাঞ্জাবি",
          "order": 3
        },
        {
          "name": "লুঙ্গি",
          "order": 4
        },
        {
          "name": "টি-শার্ট/গেঞ্জি",
          "order": 5
        },
        {
          "name": "পোলো শার্ট",
          "order": 6
        },
        {
          "name": "জ্যাকেট",
          "order": 7
        },
        {
          "name": "কোট/ব্লেজার",
          "order": 8
        },
        {
          "name": "সোয়েটার",
          "order": 9
        },
        {
          "name": "আন্ডারগার্মেন্টস",
          "order": 10
        },
        {
          "name": "শর্টস/হাফ প্যান্ট",
          "order": 11
        },
        {
          "name": "জিন্স",
          "order": 12
        }
      ]
    },
    {
      "name": "মহিলা পোশাক",
      "icon": "dress",
      "order": 2,
      "subcategories": [
        {
          "name": "শাড়ি",
          "order": 1
        },
        {
          "name": "সালোয়ার কামিজ",
          "order": 2
        },
        {
          "name": "থ্রি-পিস",
          "order": 3
        },
        {
          "name": "কুর্তি",
          "order": 4
        },
        {
          "name": "ব্লাউজ",
          "order": 5
        },
        {
          "name": "বোরকা/হিজাব",
          "order": 6
        },
        {
          "name": "লেহেঙ্গা",
          "order": 7
        },
        {
          "name": "স্কার্ট",
          "order": 8
        },
        {
          "name": "ম্যাক্সি ড্রেস",
          "order": 9
        },
        {
          "name": "নাইটওয়্যার",
          "order": 10
        },
        {
          "name": "আন্ডারগার্মেন্টস",
          "order": 11
        }
      ]
    },
    {
      "name": "শিশু পোশাক",
      "icon": "baby",
      "order": 3,
      "subcategories": [
        {
          "name": "ছেলেদের পোশাক",
          "order": 1
        },
        {
          "name": "মেয়েদের পোশাক",
          "order": 2
        },
        {
          "name": "বেবি পোশাক (০-২ বছর)",
          "order": 3
        },
        {
          "name": "স্কুল ইউনিফর্ম",
          "order": 4
        },
        {
          "name": "শিশু আন্ডারওয়্যার",
          "order": 5
        }
      ]
    },
    {
      "name": "কাপড়/থান",
      "icon": "scissors",
      "order": 4,
      "subcategories": [
        {
          "name": "সুতি কাপড়",
          "order": 1
        },
        {
          "name": "সিল্ক",
          "order": 2
        },
        {
          "name": "জর্জেট",
          "order": 3
        },
        {
          "name": "লিনেন",
          "order": 4
        },
        {
          "name": "শিফন",
          "order": 5
        },
        {
          "name": "পলিয়েস্টার",
          "order": 6
        },
        {
          "name": "মসলিন",
          "order": 7
        },
        {
          "name": "ভয়েল",
          "order": 8
        }
      ]
    },
    {
      "name": "জুতা/স্যান্ডেল",
      "icon": "footprints",
      "order": 5,
      "subcategories": [
        {
          "name": "পুরুষ জুতা",
          "order": 1
        },
        {
          "name": "মহিলা জুতা",
          "order": 2
        },
        {
          "name": "স্যান্ডেল",
          "order": 3
        },
        {
          "name": "কেডস/স্নিকার্স",
          "order": 4
        },
        {
          "name": "শিশু জুতা",
          "order": 5
        },
        {
          "name": "চপ্পল/স্লিপার",
          "order": 6
        }
      ]
    },
    {
      "name": "আনুষাঙ্গিক",
      "icon": "glasses",
      "order": 6,
      "subcategories": [
        {
          "name": "টুপি/ক্যাপ",
          "order": 1
        },
        {
          "name": "বেল্ট",
          "order": 2
        },
        {
          "name": "ওড়না/স্কার্ফ",
          "order": 3
        },
        {
          "name": "টাই/বো",
          "order": 4
        },
        {
          "name": "মোজা",
          "order": 5
        },
        {
          "name": "ব্যাগ",
          "order": 6
        },
        {
          "name": "মানিব্যাগ/ওয়ালেট",
          "order": 7
        },
        {
          "name": "গামছা/তোয়ালে",
          "order": 8
        },
        {
          "name": "গহনা/জুয়েলারি",
          "order": 9
        }
      ]
    },
    {
      "name": "সেলাই সামগ্রী",
      "icon": "needle",
      "order": 7,
      "subcategories": [
        {
          "name": "সুতা",
          "order": 1
        },
        {
          "name": "বোতাম",
          "order": 2
        },
        {
          "name": "জিপার/চেইন",
          "order": 3
        },
        {
          "name": "লেস/বর্ডার",
          "order": 4
        },
        {
          "name": "ইলাস্টিক",
          "order": 5
        }
      ]
    }
  ],
  "grocery": [
    {
      "name": "চাল ও ডাল",
      "icon": "wheat",
      "order": 1,
      "subcategories": [
        {
          "name": "মিনিকেট চাল",
          "order": 1
        },
        {
          "name": "নাজিরশাইল চাল",
          "order": 2
        },
        {
          "name": "বাসমতি চাল",
          "order": 3
        },
        {
          "name": "আতপ চাল",
          "order": 4
        },
        {
          "name": "পোলাও চাল",
          "order": 5
        },
        {
          "name": "মসুর ডাল",
          "order": 6
        },
        {
          "name": "মুগ ডাল",
          "order": 7
        },
        {
          "name": "বুটের/চোলার ডাল",
          "order": 8
        },
        {
          "name": "খেসারি ডাল",
          "order": 9
        },
        {
          "name": "মটর ডাল",
          "order": 10
        }
      ]
    },
    {
      "name": "তেল ও মশলা",
      "icon": "flame",
      "order": 2,
      "subcategories": [
        {
          "name": "সয়াবিন তেল",
          "order": 1
        },
        {
          "name": "সরিষার তেল",
          "order": 2
        },
        {
          "name": "পাম অয়েল",
          "order": 3
        },
        {
          "name": "হলুদ",
          "order": 4
        },
        {
          "name": "মরিচ গুঁড়া",
          "order": 5
        },
        {
          "name": "জিরা",
          "order": 6
        },
        {
          "name": "ধনে",
          "order": 7
        },
        {
          "name": "রসুন",
          "order": 8
        },
        {
          "name": "আদা",
          "order": 9
        },
        {
          "name": "পেঁয়াজ",
          "order": 10
        },
        {
          "name": "গরম মশলা",
          "order": 11
        },
        {
          "name": "তেজপাতা",
          "order": 12
        },
        {
          "name": "দারুচিনি",
          "order": 13
        },
        {
          "name": "এলাচ",
          "order": 14
        }
      ]
    },
    {
      "name": "আটা ও শস্য",
      "icon": "grain",
      "order": 3,
      "subcategories": [
        {
          "name": "আটা",
          "order": 1
        },
        {
          "name": "ময়দা",
          "order": 2
        },
        {
          "name": "সুজি",
          "order": 3
        },
        {
          "name": "চিড়া",
          "order": 4
        },
        {
          "name": "মুড়ি",
          "order": 5
        },
        {
          "name": "কর্ন ফ্লাওয়ার",
          "order": 6
        },
        {
          "name": "নুডলস/সেমাই",
          "order": 7
        },
        {
          "name": "রুটি/পাউরুটি",
          "order": 8
        }
      ]
    },
    {
      "name": "চিনি ও লবণ",
      "icon": "candy",
      "order": 4,
      "subcategories": [
        {
          "name": "চিনি",
          "order": 1
        },
        {
          "name": "লবণ",
          "order": 2
        },
        {
          "name": "গুড়",
          "order": 3
        },
        {
          "name": "মধু",
          "order": 4
        }
      ]
    },
    {
      "name": "চা ও পানীয়",
      "icon": "coffee",
      "order": 5,
      "subcategories": [
        {
          "name": "চা পাতা",
          "order": 1
        },
        {
          "name": "কফি",
          "order": 2
        },
        {
          "name": "গুঁড়া দুধ",
          "order": 3
        },
        {
          "name": "জুস/ড্রিংকস",
          "order": 4
        },
        {
          "name": "পানি (বোতল)",
          "order": 5
        },
        {
          "name": "কোমল পানীয়",
          "order": 6
        }
      ]
    },
    {
      "name": "স্ন্যাকস ও বিস্কুট",
      "icon": "cookie",
      "order": 6,
      "subcategories": [
        {
          "name": "বিস্কুট",
          "order": 1
        },
        {
          "name": "চিপস",
          "order": 2
        },
        {
          "name": "চানাচুর",
          "order": 3
        },
        {
          "name": "চকলেট",
          "order": 4
        },
        {
          "name": "কেক",
          "order": 5
        },
        {
          "name": "ইনস্ট্যান্ট নুডলস",
          "order": 6
        },
        {
          "name": "বাদাম ও শুকনো ফল",
          "order": 7
        }
      ]
    },
    {
      "name": "সাবান ও পরিষ্কারক",
      "icon": "sparkles",
      "order": 7,
      "subcategories": [
        {
          "name": "গোসলের সাবান",
          "order": 1
        },
        {
          "name": "কাপড় ধোয়ার সাবান",
          "order": 2
        },
        {
          "name": "ডিটারজেন্ট পাউডার",
          "order": 3
        },
        {
          "name": "লিকুইড ডিটারজেন্ট",
          "order": 4
        },
        {
          "name": "ডিশ ওয়াশ",
          "order": 5
        },
        {
          "name": "ফ্লোর ক্লিনার",
          "order": 6
        },
        {
          "name": "টয়লেট ক্লিনার",
          "order": 7
        }
      ]
    },
    {
      "name": "ব্যক্তিগত যত্ন",
      "icon": "sparkle",
      "order": 8,
      "subcategories": [
        {
          "name": "শ্যাম্পু",
          "order": 1
        },
        {
          "name": "চুলের তেল",
          "order": 2
        },
        {
          "name": "ক্রিম/লোশন",
          "order": 3
        },
        {
          "name": "টুথপেস্ট",
          "order": 4
        },
        {
          "name": "টুথব্রাশ",
          "order": 5
        },
        {
          "name": "রেজার/ব্লেড",
          "order": 6
        },
        {
          "name": "টিস্যু/ন্যাপকিন",
          "order": 7
        }
      ]
    },
    {
      "name": "শিশু খাদ্য ও দুগ্ধ",
      "icon": "milk",
      "order": 9,
      "subcategories": [
        {
          "name": "গুঁড়া দুধ",
          "order": 1
        },
        {
          "name": "সেরেলাক/বেবি ফুড",
          "order": 2
        },
        {
          "name": "ডায়পার",
          "order": 3
        },
        {
          "name": "ঘন দুধ",
          "order": 4
        },
        {
          "name": "দই",
          "order": 5
        },
        {
          "name": "ঘি/মাখন",
          "order": 6
        }
      ]
    },
    {
      "name": "বিবিধ",
      "icon": "package",
      "order": 10,
      "subcategories": [
        {
          "name": "দিয়াশলাই",
          "order": 1
        },
        {
          "name": "ব্যাটারি",
          "order": 2
        },
        {
          "name": "মোমবাতি",
          "order": 3
        },
        {
          "name": "মশা মারার কয়েল",
          "order": 4
        },
        {
          "name": "প্লাস্টিক ব্যাগ/প্যাকেট",
          "order": 5
        },
        {
          "name": "আগরবাতি",
          "order": 6
        }
      ]
    }
  ],
  "electronics": [
    {
      "name": "মোবাইল ও ট্যাবলেট",
      "icon": "smartphone",
      "order": 1,
      "subcategories": [
        {
          "name": "স্মার্টফোন",
          "order": 1
        },
        {
          "name": "ফিচার ফোন",
          "order": 2
        },
        {
          "name": "ট্যাবলেট",
          "order": 3
        },
        {
          "name": "স্মার্টওয়াচ",
          "order": 4
        }
      ]
    },
    {
      "name": "মোবাইল এক্সেসরিজ",
      "icon": "cable",
      "order": 2,
      "subcategories": [
        {
          "name": "চার্জার",
          "order": 1
        },
        {
          "name": "ক্যাবল/কর্ড",
          "order": 2
        },
        {
          "name": "ইয়ারফোন/হেডফোন",
          "order": 3
        },
        {
          "name": "কেস/কভার",
          "order": 4
        },
        {
          "name": "স্ক্রিন প্রটেক্টর",
          "order": 5
        },
        {
          "name": "পাওয়ার ব্যাংক",
          "order": 6
        },
        {
          "name": "ব্লুটুথ স্পিকার",
          "order": 7
        },
        {
          "name": "মেমোরি কার্ড",
          "order": 8
        },
        {
          "name": "সিম কার্ড",
          "order": 9
        },
        {
          "name": "হোল্ডার/স্ট্যান্ড",
          "order": 10
        }
      ]
    },
    {
      "name": "কম্পিউটার ও ল্যাপটপ",
      "icon": "laptop",
      "order": 3,
      "subcategories": [
        {
          "name": "ল্যাপটপ",
          "order": 1
        },
        {
          "name": "ডেস্কটপ",
          "order": 2
        },
        {
          "name": "মনিটর",
          "order": 3
        },
        {
          "name": "প্রিন্টার",
          "order": 4
        },
        {
          "name": "ইউপিএস/আইপিএস",
          "order": 5
        }
      ]
    },
    {
      "name": "কম্পিউটার এক্সেসরিজ",
      "icon": "mouse",
      "order": 4,
      "subcategories": [
        {
          "name": "মাউস",
          "order": 1
        },
        {
          "name": "কিবোর্ড",
          "order": 2
        },
        {
          "name": "পেনড্রাইভ",
          "order": 3
        },
        {
          "name": "হার্ড ডিস্ক/SSD",
          "order": 4
        },
        {
          "name": "র‍্যাম",
          "order": 5
        },
        {
          "name": "ওয়েবক্যাম",
          "order": 6
        },
        {
          "name": "মাউস প্যাড",
          "order": 7
        },
        {
          "name": "ইউএসবি হাব",
          "order": 8
        },
        {
          "name": "কালি/টোনার",
          "order": 9
        }
      ]
    },
    {
      "name": "টিভি ও সাউন্ড",
      "icon": "tv",
      "order": 5,
      "subcategories": [
        {
          "name": "টেলিভিশন",
          "order": 1
        },
        {
          "name": "সাউন্ডবার",
          "order": 2
        },
        {
          "name": "স্পিকার",
          "order": 3
        },
        {
          "name": "হোম থিয়েটার",
          "order": 4
        },
        {
          "name": "মাইক্রোফোন",
          "order": 5
        },
        {
          "name": "অ্যাম্প্লিফায়ার",
          "order": 6
        }
      ]
    },
    {
      "name": "ঘরের যন্ত্রপাতি",
      "icon": "plug",
      "order": 6,
      "subcategories": [
        {
          "name": "ফ্যান",
          "order": 1
        },
        {
          "name": "লাইট/বাল্ব",
          "order": 2
        },
        {
          "name": "আয়রন/ইস্ত্রি",
          "order": 3
        },
        {
          "name": "ব্লেন্ডার",
          "order": 4
        },
        {
          "name": "রাইস কুকার",
          "order": 5
        },
        {
          "name": "মাইক্রোওয়েভ ওভেন",
          "order": 6
        },
        {
          "name": "ওয়াটার হিটার",
          "order": 7
        },
        {
          "name": "এসি",
          "order": 8
        },
        {
          "name": "রেফ্রিজারেটর/ফ্রিজ",
          "order": 9
        },
        {
          "name": "ওয়াশিং মেশিন",
          "order": 10
        }
      ]
    },
    {
      "name": "ক্যামেরা ও সিকিউরিটি",
      "icon": "camera",
      "order": 7,
      "subcategories": [
        {
          "name": "সিসিটিভি ক্যামেরা",
          "order": 1
        },
        {
          "name": "আইপি ক্যামেরা",
          "order": 2
        },
        {
          "name": "DVR/NVR",
          "order": 3
        },
        {
          "name": "ডিজিটাল ক্যামেরা",
          "order": 4
        },
        {
          "name": "অ্যাকশন ক্যামেরা",
          "order": 5
        }
      ]
    },
    {
      "name": "নেটওয়ার্কিং",
      "icon": "wifi",
      "order": 8,
      "subcategories": [
        {
          "name": "রাউটার",
          "order": 1
        },
        {
          "name": "সুইচ/হাব",
          "order": 2
        },
        {
          "name": "নেটওয়ার্ক ক্যাবল",
          "order": 3
        },
        {
          "name": "কানেক্টর/RJ45",
          "order": 4
        },
        {
          "name": "ওএনইউ/মডেম",
          "order": 5
        }
      ]
    },
    {
      "name": "গেমিং",
      "icon": "gamepad",
      "order": 9,
      "subcategories": [
        {
          "name": "গেম কনসোল",
          "order": 1
        },
        {
          "name": "কন্ট্রোলার/গেমপ্যাড",
          "order": 2
        },
        {
          "name": "গেমিং হেডসেট",
          "order": 3
        },
        {
          "name": "গেমিং এক্সেসরিজ",
          "order": 4
        }
      ]
    }
  ],
  "pharmacy": [
    {
      "name": "ওষুধ - ট্যাবলেট",
      "icon": "pill",
      "order": 1,
      "subcategories": [
        {
          "name": "জ্বরের ওষুধ",
          "order": 1
        },
        {
          "name": "অ্যান্টিবায়োটিক",
          "order": 2
        },
        {
          "name": "ব্যথানাশক",
          "order": 3
        },
        {
          "name": "গ্যাসের ওষুধ",
          "order": 4
        },
        {
          "name": "এলার্জির ওষুধ",
          "order": 5
        },
        {
          "name": "প্রেসারের ওষুধ",
          "order": 6
        },
        {
          "name": "ডায়াবেটিসের ওষুধ",
          "order": 7
        },
        {
          "name": "হৃদরোগের ওষুধ",
          "order": 8
        }
      ]
    },
    {
      "name": "ওষুধ - তরল",
      "icon": "beaker",
      "order": 2,
      "subcategories": [
        {
          "name": "সিরাপ",
          "order": 1
        },
        {
          "name": "সাসপেনশন",
          "order": 2
        },
        {
          "name": "ড্রপ",
          "order": 3
        },
        {
          "name": "ইনজেকশন",
          "order": 4
        },
        {
          "name": "স্যালাইন",
          "order": 5
        }
      ]
    },
    {
      "name": "ওষুধ - বাহ্যিক",
      "icon": "cream",
      "order": 3,
      "subcategories": [
        {
          "name": "মলম/ক্রিম",
          "order": 1
        },
        {
          "name": "চোখের ড্রপ",
          "order": 2
        },
        {
          "name": "কানের ড্রপ",
          "order": 3
        },
        {
          "name": "নাকের স্প্রে",
          "order": 4
        },
        {
          "name": "ইনহেলার",
          "order": 5
        },
        {
          "name": "সাপোজিটরি",
          "order": 6
        }
      ]
    },
    {
      "name": "ভিটামিন ও সাপ্লিমেন্ট",
      "icon": "dumbbell",
      "order": 4,
      "subcategories": [
        {
          "name": "মাল্টিভিটামিন",
          "order": 1
        },
        {
          "name": "ভিটামিন সি",
          "order": 2
        },
        {
          "name": "ভিটামিন ডি",
          "order": 3
        },
        {
          "name": "ক্যালসিয়াম",
          "order": 4
        },
        {
          "name": "আয়রন",
          "order": 5
        },
        {
          "name": "জিংক",
          "order": 6
        },
        {
          "name": "ওমেগা ৩/ফিশ অয়েল",
          "order": 7
        },
        {
          "name": "প্রোটিন সাপ্লিমেন্ট",
          "order": 8
        }
      ]
    },
    {
      "name": "প্রাথমিক চিকিৎসা",
      "icon": "cross",
      "order": 5,
      "subcategories": [
        {
          "name": "ব্যান্ডেজ",
          "order": 1
        },
        {
          "name": "গজ",
          "order": 2
        },
        {
          "name": "প্লাস্টার",
          "order": 3
        },
        {
          "name": "তুলা",
          "order": 4
        },
        {
          "name": "অ্যান্টিসেপটিক",
          "order": 5
        },
        {
          "name": "স্যানিটাইজার",
          "order": 6
        },
        {
          "name": "মাস্ক",
          "order": 7
        },
        {
          "name": "গ্লাভস",
          "order": 8
        }
      ]
    },
    {
      "name": "চিকিৎসা সরঞ্জাম",
      "icon": "stethoscope",
      "order": 6,
      "subcategories": [
        {
          "name": "থার্মোমিটার",
          "order": 1
        },
        {
          "name": "বিপি মেশিন",
          "order": 2
        },
        {
          "name": "গ্লুকোমিটার",
          "order": 3
        },
        {
          "name": "নেবুলাইজার",
          "order": 4
        },
        {
          "name": "অক্সিমিটার",
          "order": 5
        },
        {
          "name": "হুইলচেয়ার/ক্রাচ",
          "order": 6
        },
        {
          "name": "টেস্ট স্ট্রিপ",
          "order": 7
        },
        {
          "name": "সিরিঞ্জ",
          "order": 8
        }
      ]
    },
    {
      "name": "শিশু স্বাস্থ্য",
      "icon": "baby",
      "order": 7,
      "subcategories": [
        {
          "name": "বেবি ড্রপ",
          "order": 1
        },
        {
          "name": "গ্রাইপ ওয়াটার",
          "order": 2
        },
        {
          "name": "ডায়পার ক্রিম",
          "order": 3
        },
        {
          "name": "বেবি পাউডার",
          "order": 4
        },
        {
          "name": "বেবি সাবান/ওয়াশ",
          "order": 5
        },
        {
          "name": "ফিডার/বোতল",
          "order": 6
        }
      ]
    },
    {
      "name": "মহিলা স্বাস্থ্য",
      "icon": "heart",
      "order": 8,
      "subcategories": [
        {
          "name": "স্যানিটারি ন্যাপকিন",
          "order": 1
        },
        {
          "name": "গর্ভনিরোধক",
          "order": 2
        },
        {
          "name": "প্রেগন্যান্সি টেস্ট",
          "order": 3
        },
        {
          "name": "ফলিক অ্যাসিড",
          "order": 4
        }
      ]
    },
    {
      "name": "ব্যক্তিগত যত্ন",
      "icon": "sparkle",
      "order": 9,
      "subcategories": [
        {
          "name": "টুথপেস্ট",
          "order": 1
        },
        {
          "name": "মাউথওয়াশ",
          "order": 2
        },
        {
          "name": "শ্যাম্পু",
          "order": 3
        },
        {
          "name": "সাবান",
          "order": 4
        },
        {
          "name": "ফেসওয়াশ",
          "order": 5
        },
        {
          "name": "সানস্ক্রিন",
          "order": 6
        },
        {
          "name": "বডি লোশন",
          "order": 7
        }
      ]
    }
  ],
  "hardware": [
    {
      "name": "হাতের যন্ত্র",
      "icon": "wrench",
      "order": 1,
      "subcategories": [
        {
          "name": "হাতুড়ি",
          "order": 1
        },
        {
          "name": "প্লায়ার্স",
          "order": 2
        },
        {
          "name": "স্ক্রু ড্রাইভার",
          "order": 3
        },
        {
          "name": "রেঞ্চ/স্প্যানার",
          "order": 4
        },
        {
          "name": "কাটার/ছুরি",
          "order": 5
        },
        {
          "name": "মাপার ফিতা",
          "order": 6
        },
        {
          "name": "লেভেল/ওয়াটার লেভেল",
          "order": 7
        },
        {
          "name": "করাত",
          "order": 8
        },
        {
          "name": "ড্রিল মেশিন",
          "order": 9
        },
        {
          "name": "টুল সেট",
          "order": 10
        }
      ]
    },
    {
      "name": "ইলেকট্রিক্যাল",
      "icon": "zap",
      "order": 2,
      "subcategories": [
        {
          "name": "তার/ক্যাবল",
          "order": 1
        },
        {
          "name": "সুইচ/সকেট",
          "order": 2
        },
        {
          "name": "প্লাগ/কানেক্টর",
          "order": 3
        },
        {
          "name": "সার্কিট ব্রেকার",
          "order": 4
        },
        {
          "name": "বাল্ব/লাইট",
          "order": 5
        },
        {
          "name": "টিউব লাইট",
          "order": 6
        },
        {
          "name": "ফ্যান",
          "order": 7
        },
        {
          "name": "মাল্টিপ্লাগ/এক্সটেনশন",
          "order": 8
        },
        {
          "name": "টেপ/ইনসুলেশন",
          "order": 9
        }
      ]
    },
    {
      "name": "পাইপ ও ফিটিংস",
      "icon": "pipe",
      "order": 3,
      "subcategories": [
        {
          "name": "পিভিসি পাইপ",
          "order": 1
        },
        {
          "name": "জিআই পাইপ",
          "order": 2
        },
        {
          "name": "পাইপ ফিটিংস",
          "order": 3
        },
        {
          "name": "ট্যাপ/কল",
          "order": 4
        },
        {
          "name": "ভালভ",
          "order": 5
        },
        {
          "name": "পানির ট্যাংক",
          "order": 6
        },
        {
          "name": "পানির পাম্প",
          "order": 7
        }
      ]
    },
    {
      "name": "রং ও কেমিক্যাল",
      "icon": "paint-bucket",
      "order": 4,
      "subcategories": [
        {
          "name": "দেয়ালের রং",
          "order": 1
        },
        {
          "name": "কাঠের রং/বার্নিশ",
          "order": 2
        },
        {
          "name": "স্প্রে পেইন্ট",
          "order": 3
        },
        {
          "name": "থিনার",
          "order": 4
        },
        {
          "name": "পুটি",
          "order": 5
        },
        {
          "name": "সিলিকন/সিল্যান্ট",
          "order": 6
        },
        {
          "name": "গ্লু/আঠা",
          "order": 7
        },
        {
          "name": "ব্রাশ/রোলার",
          "order": 8
        }
      ]
    },
    {
      "name": "তালা ও কব্জা",
      "icon": "lock",
      "order": 5,
      "subcategories": [
        {
          "name": "তালা",
          "order": 1
        },
        {
          "name": "দরজার লক",
          "order": 2
        },
        {
          "name": "কব্জা",
          "order": 3
        },
        {
          "name": "দরজার হ্যান্ডেল",
          "order": 4
        },
        {
          "name": "খিল/স্লাইড",
          "order": 5
        },
        {
          "name": "ডোর ক্লোজার",
          "order": 6
        },
        {
          "name": "জানালার ফিটিংস",
          "order": 7
        }
      ]
    },
    {
      "name": "বাথরুম ফিটিংস",
      "icon": "droplets",
      "order": 6,
      "subcategories": [
        {
          "name": "শাওয়ার",
          "order": 1
        },
        {
          "name": "কমোড",
          "order": 2
        },
        {
          "name": "বেসিন/সিংক",
          "order": 3
        },
        {
          "name": "তোয়ালে র‍্যাক",
          "order": 4
        },
        {
          "name": "সাবানদানি",
          "order": 5
        },
        {
          "name": "আয়না",
          "order": 6
        }
      ]
    },
    {
      "name": "নির্মাণ সামগ্রী",
      "icon": "building",
      "order": 7,
      "subcategories": [
        {
          "name": "সিমেন্ট",
          "order": 1
        },
        {
          "name": "রড/স্টিল",
          "order": 2
        },
        {
          "name": "ইট",
          "order": 3
        },
        {
          "name": "বালু",
          "order": 4
        },
        {
          "name": "পাথর/খোয়া",
          "order": 5
        },
        {
          "name": "টাইলস",
          "order": 6
        }
      ]
    },
    {
      "name": "নাট-বোল্ট ও বিবিধ",
      "icon": "package",
      "order": 8,
      "subcategories": [
        {
          "name": "নাট/বোল্ট",
          "order": 1
        },
        {
          "name": "স্ক্রু/পেরেক",
          "order": 2
        },
        {
          "name": "দড়ি/চেইন",
          "order": 3
        },
        {
          "name": "জাল/তারজালি",
          "order": 4
        },
        {
          "name": "হুক/অ্যাংকর",
          "order": 5
        },
        {
          "name": "ক্ল্যাম্প",
          "order": 6
        }
      ]
    }
  ],
  "cosmetics": [
    {
      "name": "স্কিনকেয়ার",
      "icon": "droplet",
      "order": 1,
      "subcategories": [
        {
          "name": "ফেসওয়াশ",
          "order": 1
        },
        {
          "name": "ক্লিনজার",
          "order": 2
        },
        {
          "name": "টোনার",
          "order": 3
        },
        {
          "name": "সিরাম",
          "order": 4
        },
        {
          "name": "ময়েশ্চারাইজার",
          "order": 5
        },
        {
          "name": "সানস্ক্রিন",
          "order": 6
        },
        {
          "name": "নাইট ক্রিম",
          "order": 7
        },
        {
          "name": "আই ক্রিম",
          "order": 8
        },
        {
          "name": "ফেস মাস্ক/প্যাক",
          "order": 9
        },
        {
          "name": "লিপ বাম",
          "order": 10
        },
        {
          "name": "ফেয়ারনেস ক্রিম",
          "order": 11
        }
      ]
    },
    {
      "name": "মেকআপ",
      "icon": "palette",
      "order": 2,
      "subcategories": [
        {
          "name": "ফাউন্ডেশন",
          "order": 1
        },
        {
          "name": "কনসিলার",
          "order": 2
        },
        {
          "name": "কম্প্যাক্ট পাউডার",
          "order": 3
        },
        {
          "name": "লুজ পাউডার",
          "order": 4
        },
        {
          "name": "লিপস্টিক",
          "order": 5
        },
        {
          "name": "লিপ গ্লস",
          "order": 6
        },
        {
          "name": "আইলাইনার",
          "order": 7
        },
        {
          "name": "কাজল/সুরমা",
          "order": 8
        },
        {
          "name": "মাসকারা",
          "order": 9
        },
        {
          "name": "আই শ্যাডো",
          "order": 10
        },
        {
          "name": "ব্লাশ/রুজ",
          "order": 11
        },
        {
          "name": "প্রাইমার",
          "order": 12
        },
        {
          "name": "সেটিং স্প্রে",
          "order": 13
        },
        {
          "name": "মেকআপ রিমুভার",
          "order": 14
        }
      ]
    },
    {
      "name": "হেয়ারকেয়ার",
      "icon": "wind",
      "order": 3,
      "subcategories": [
        {
          "name": "শ্যাম্পু",
          "order": 1
        },
        {
          "name": "কন্ডিশনার",
          "order": 2
        },
        {
          "name": "হেয়ার অয়েল",
          "order": 3
        },
        {
          "name": "হেয়ার সিরাম",
          "order": 4
        },
        {
          "name": "হেয়ার জেল/ওয়াক্স",
          "order": 5
        },
        {
          "name": "হেয়ার মাস্ক",
          "order": 6
        },
        {
          "name": "হেয়ার কালার/ডাই",
          "order": 7
        },
        {
          "name": "মেহেদি/হেনা",
          "order": 8
        },
        {
          "name": "অ্যান্টি-ড্যানড্রাফ",
          "order": 9
        }
      ]
    },
    {
      "name": "বডি কেয়ার",
      "icon": "sparkles",
      "order": 4,
      "subcategories": [
        {
          "name": "বডি লোশন",
          "order": 1
        },
        {
          "name": "বডি ওয়াশ/শাওয়ার জেল",
          "order": 2
        },
        {
          "name": "সাবান",
          "order": 3
        },
        {
          "name": "বডি স্ক্রাব",
          "order": 4
        },
        {
          "name": "বডি অয়েল",
          "order": 5
        },
        {
          "name": "হ্যান্ড ক্রিম",
          "order": 6
        },
        {
          "name": "ফুট ক্রিম",
          "order": 7
        },
        {
          "name": "ডিওডোরেন্ট",
          "order": 8
        }
      ]
    },
    {
      "name": "সুগন্ধি",
      "icon": "flower",
      "order": 5,
      "subcategories": [
        {
          "name": "পারফিউম",
          "order": 1
        },
        {
          "name": "বডি স্প্রে",
          "order": 2
        },
        {
          "name": "আতর",
          "order": 3
        },
        {
          "name": "বডি মিস্ট",
          "order": 4
        },
        {
          "name": "রোল অন",
          "order": 5
        }
      ]
    },
    {
      "name": "নখের যত্ন",
      "icon": "hand",
      "order": 6,
      "subcategories": [
        {
          "name": "নেইল পলিশ",
          "order": 1
        },
        {
          "name": "নেইল রিমুভার",
          "order": 2
        },
        {
          "name": "নেইল আর্ট",
          "order": 3
        },
        {
          "name": "নেইল ফাইল",
          "order": 4
        },
        {
          "name": "নেইল কাটার",
          "order": 5
        },
        {
          "name": "কিউটিকল অয়েল",
          "order": 6
        }
      ]
    },
    {
      "name": "মেন'স গ্রুমিং",
      "icon": "user",
      "order": 7,
      "subcategories": [
        {
          "name": "শেভিং ক্রিম/ফোম",
          "order": 1
        },
        {
          "name": "আফটার শেভ",
          "order": 2
        },
        {
          "name": "রেজার/ব্লেড",
          "order": 3
        },
        {
          "name": "ট্রিমার",
          "order": 4
        },
        {
          "name": "মেন'স ফেসওয়াশ",
          "order": 5
        },
        {
          "name": "মেন'স ক্রিম",
          "order": 6
        },
        {
          "name": "মেন'স ডিওডোরেন্ট",
          "order": 7
        },
        {
          "name": "বিয়ার্ড অয়েল",
          "order": 8
        }
      ]
    },
    {
      "name": "বিউটি সরঞ্জাম",
      "icon": "wand",
      "order": 8,
      "subcategories": [
        {
          "name": "মেকআপ ব্রাশ সেট",
          "order": 1
        },
        {
          "name": "স্পঞ্জ/পাফ",
          "order": 2
        },
        {
          "name": "আয়না",
          "order": 3
        },
        {
          "name": "হেয়ার ড্রায়ার",
          "order": 4
        },
        {
          "name": "স্ট্রেইটনার",
          "order": 5
        },
        {
          "name": "কার্লার",
          "order": 6
        },
        {
          "name": "চিরুনি/ব্রাশ",
          "order": 7
        },
        {
          "name": "আইল্যাশ কার্লার",
          "order": 8
        },
        {
          "name": "টুইজার",
          "order": 9
        }
      ]
    }
  ],
  "bookshop": [
    {
      "name": "পাঠ্যবই",
      "icon": "book-open",
      "order": 1,
      "subcategories": [
        {
          "name": "প্রাথমিক",
          "order": 1
        },
        {
          "name": "মাধ্যমিক",
          "order": 2
        },
        {
          "name": "উচ্চ মাধ্যমিক",
          "order": 3
        },
        {
          "name": "বিশ্ববিদ্যালয়",
          "order": 4
        }
      ]
    },
    {
      "name": "নোটবুক ও খাতা",
      "icon": "notebook",
      "order": 2,
      "subcategories": [
        {
          "name": "এক্সারসাইজ খাতা",
          "order": 1
        },
        {
          "name": "ড্রয়িং খাতা",
          "order": 2
        },
        {
          "name": "ল্যাব খাতা",
          "order": 3
        },
        {
          "name": "প্র্যাকটিক্যাল খাতা",
          "order": 4
        }
      ]
    },
    {
      "name": "স্টেশনারি",
      "icon": "pen",
      "order": 3,
      "subcategories": [
        {
          "name": "কলম",
          "order": 1
        },
        {
          "name": "পেন্সিল",
          "order": 2
        },
        {
          "name": "রাবার",
          "order": 3
        },
        {
          "name": "শার্পনার",
          "order": 4
        },
        {
          "name": "স্কেল",
          "order": 5
        }
      ]
    },
    {
      "name": "গল্প/উপন্যাস",
      "icon": "book",
      "order": 4,
      "subcategories": [
        {
          "name": "বাংলা সাহিত্য",
          "order": 1
        },
        {
          "name": "অনুবাদ",
          "order": 2
        },
        {
          "name": "শিশু সাহিত্য",
          "order": 3
        },
        {
          "name": "ইসলামিক বই",
          "order": 4
        }
      ]
    },
    {
      "name": "রেফারেন্স বই",
      "icon": "library",
      "order": 5,
      "subcategories": [
        {
          "name": "অভিধান",
          "order": 1
        },
        {
          "name": "এনসাইক্লোপিডিয়া",
          "order": 2
        },
        {
          "name": "গাইড বই",
          "order": 3
        },
        {
          "name": "প্রশ্নব্যাংক",
          "order": 4
        }
      ]
    },
    {
      "name": "ব্যাগ ও এক্সেসরিজ",
      "icon": "backpack",
      "order": 6,
      "subcategories": [
        {
          "name": "স্কুল ব্যাগ",
          "order": 1
        },
        {
          "name": "টিফিন বক্স",
          "order": 2
        },
        {
          "name": "পানির বোতল",
          "order": 3
        },
        {
          "name": "পেন্সিল বক্স",
          "order": 4
        }
      ]
    },
    {
      "name": "আর্ট ও ক্রাফট",
      "icon": "palette",
      "order": 7,
      "subcategories": [
        {
          "name": "রং",
          "order": 1
        },
        {
          "name": "তুলি",
          "order": 2
        },
        {
          "name": "ক্রাফট পেপার",
          "order": 3
        },
        {
          "name": "গ্লু",
          "order": 4
        }
      ]
    },
    {
      "name": "ধর্মীয় বই",
      "icon": "book-marked",
      "order": 8,
      "subcategories": [
        {
          "name": "কুরআন",
          "order": 1
        },
        {
          "name": "হাদিস",
          "order": 2
        },
        {
          "name": "ইসলামিক বই",
          "order": 3
        },
        {
          "name": "অন্যান্য",
          "order": 4
        }
      ]
    }
  ],
  "other": [
    {
      "name": "সাধারণ পণ্য",
      "icon": "package",
      "order": 1,
      "subcategories": []
    },
    {
      "name": "খাদ্যদ্রব্য",
      "icon": "utensils",
      "order": 2,
      "subcategories": []
    },
    {
      "name": "পানীয়",
      "icon": "coffee",
      "order": 3,
      "subcategories": []
    },
    {
      "name": "গৃহস্থালি",
      "icon": "home",
      "order": 4,
      "subcategories": []
    },
    {
      "name": "পরিধান",
      "icon": "shirt",
      "order": 5,
      "subcategories": []
    },
    {
      "name": "ইলেকট্রনিক্স",
      "icon": "zap",
      "order": 6,
      "subcategories": []
    },
    {
      "name": "স্বাস্থ্য ও সৌন্দর্য",
      "icon": "heart",
      "order": 7,
      "subcategories": []
    },
    {
      "name": "খেলনা ও শিশু",
      "icon": "baby",
      "order": 8,
      "subcategories": []
    },
    {
      "name": "স্টেশনারি",
      "icon": "pen",
      "order": 9,
      "subcategories": []
    },
    {
      "name": "অন্যান্য",
      "icon": "box",
      "order": 10,
      "subcategories": []
    }
  ],

  "computer": [
    { name: 'ডেস্কটপ কম্পিউটার', icon: 'monitor', order: 1, subcategories: sub(['ব্র্যান্ড পিসি', 'অ্যাসেম্বল পিসি', 'অল-ইন-ওয়ান পিসি', 'গেমিং পিসি']) },
    { name: 'ল্যাপটপ', icon: 'laptop', order: 2, subcategories: sub(['নোটবুক', 'আল্ট্রাবুক', 'গেমিং ল্যাপটপ', 'ম্যাকবুক']) },
    { name: 'কম্পিউটার পার্টস', icon: 'cpu', order: 3, subcategories: sub(['প্রসেসর', 'মাদারবোর্ড', 'র‍্যাম', 'গ্রাফিক্স কার্ড', 'পাওয়ার সাপ্লাই', 'কেসিং', 'কুলিং ফ্যান']) },
    { name: 'স্টোরেজ', icon: 'hard-drive', order: 4, subcategories: sub(['হার্ডডিস্ক (HDD)', 'এসএসডি (SSD)', 'পেনড্রাইভ', 'মেমোরি কার্ড', 'এক্সটার্নাল হার্ডডিস্ক']) },
    { name: 'মনিটর ও ডিসপ্লে', icon: 'monitor-speaker', order: 5, subcategories: sub(['এলইডি মনিটর', 'গেমিং মনিটর', 'প্রজেক্টর']) },
    { name: 'প্রিন্টার ও স্ক্যানার', icon: 'printer', order: 6, subcategories: sub(['ইঙ্কজেট প্রিন্টার', 'লেজার প্রিন্টার', 'স্ক্যানার', 'টোনার ও কার্টিজ']) },
    { name: 'নেটওয়ার্কিং', icon: 'wifi', order: 7, subcategories: sub(['রাউটার', 'সুইচ', 'নেটওয়ার্ক ক্যাবল', 'নেটওয়ার্ক কার্ড']) },
    { name: 'এক্সেসরিজ', icon: 'mouse', order: 8, subcategories: sub(['কীবোর্ড', 'মাউস', 'হেডফোন', 'ওয়েবক্যাম', 'ইউপিএস', 'ল্যাপটপ ব্যাগ']) },
    { name: 'সফটওয়্যার ও লাইসেন্স', icon: 'disc', order: 9, subcategories: sub(['অপারেটিং সিস্টেম', 'অ্যান্টিভাইরাস', 'অফিস সফটওয়্যার']) }
  ],

  "dealership": [
    { name: 'ব্র্যান্ড পণ্য', icon: 'package', order: 1, subcategories: sub(['মূল পণ্য', 'নতুন পণ্য', 'অফার পণ্য']) },
    { name: 'পাইকারি প্যাক', icon: 'boxes', order: 2, subcategories: sub(['কার্টন', 'বস্তা', 'ডজন প্যাক']) },
    { name: 'খাদ্য ও পানীয়', icon: 'utensils', order: 3, subcategories: sub(['বিস্কুট ও চিপস', 'কোমল পানীয়', 'দুধ ও ডেইরি', 'চা ও কফি']) },
    { name: 'গৃহস্থালি পণ্য', icon: 'home', order: 4, subcategories: sub(['সাবান ও ডিটারজেন্ট', 'টিস্যু ও ন্যাপকিন', 'ক্লিনিং আইটেম']) },
    { name: 'নির্মাণ সামগ্রী', icon: 'hammer', order: 5, subcategories: sub(['সিমেন্ট', 'রড', 'রং', 'টাইলস']) },
    { name: 'ইলেকট্রনিক্স', icon: 'zap', order: 6, subcategories: sub(['হোম অ্যাপ্লায়েন্স', 'মোবাইল', 'লাইটিং']) },
    { name: 'কৃষি পণ্য', icon: 'sprout', order: 7, subcategories: sub(['সার', 'বীজ', 'কীটনাশক']) },
    { name: 'প্রমোশন ও গিফট', icon: 'gift', order: 8, subcategories: sub(['ফ্রি স্যাম্পল', 'গিফট আইটেম']) }
  ],

  "ecommerce": [
    { name: 'ফ্যাশন ও পোশাক', icon: 'shirt', order: 1, subcategories: sub(['পুরুষ পোশাক', 'নারী পোশাক', 'শিশু পোশাক', 'জুতা', 'ব্যাগ']) },
    { name: 'ইলেকট্রনিক্স ও গ্যাজেট', icon: 'zap', order: 2, subcategories: sub(['মোবাইল', 'স্মার্ট গ্যাজেট', 'হেডফোন', 'এক্সেসরিজ']) },
    { name: 'স্বাস্থ্য ও সৌন্দর্য', icon: 'heart', order: 3, subcategories: sub(['স্কিন কেয়ার', 'মেকআপ', 'হেয়ার কেয়ার', 'পারফিউম']) },
    { name: 'গৃহস্থালি ও লাইফস্টাইল', icon: 'home', order: 4, subcategories: sub(['হোম ডেকর', 'কিচেন আইটেম', 'বেডিং']) },
    { name: 'খাদ্য ও গ্রোসারি', icon: 'shopping-basket', order: 5, subcategories: sub(['শুকনা খাবার', 'স্ন্যাকস', 'অর্গানিক পণ্য']) },
    { name: 'শিশু ও মা', icon: 'baby', order: 6, subcategories: sub(['বেবি কেয়ার', 'খেলনা', 'ডায়াপার']) },
    { name: 'বই ও স্টেশনারি', icon: 'book', order: 7, subcategories: sub(['বই', 'খাতা', 'কলম']) },
    { name: 'গিফট আইটেম', icon: 'gift', order: 8, subcategories: sub(['উপহার সামগ্রী', 'গিফট হ্যাম্পার']) },
    { name: 'রিটার্ন ও ড্যামেজ', icon: 'rotate-ccw', order: 9, subcategories: sub(['কুরিয়ার রিটার্ন', 'ড্যামেজ পণ্য']) }
  ],

  "furniture": [
    { name: 'বেডরুম ফার্নিচার', icon: 'bed', order: 1, subcategories: sub(['খাট', 'ওয়ারড্রব', 'ড্রেসিং টেবিল', 'সাইড টেবিল', 'ম্যাট্রেস']) },
    { name: 'লিভিং রুম', icon: 'sofa', order: 2, subcategories: sub(['সোফা', 'সেন্টার টেবিল', 'টিভি ক্যাবিনেট', 'ডিভান']) },
    { name: 'ডাইনিং', icon: 'utensils', order: 3, subcategories: sub(['ডাইনিং টেবিল', 'ডাইনিং চেয়ার', 'ক্রোকারিজ শেলফ']) },
    { name: 'অফিস ফার্নিচার', icon: 'briefcase', order: 4, subcategories: sub(['অফিস ডেস্ক', 'এক্সিকিউটিভ চেয়ার', 'ফাইল ক্যাবিনেট', 'কনফারেন্স টেবিল']) },
    { name: 'কিচেন ফার্নিচার', icon: 'chef-hat', order: 5, subcategories: sub(['কিচেন ক্যাবিনেট', 'কিচেন র‍্যাক']) },
    { name: 'শিশু ফার্নিচার', icon: 'baby', order: 6, subcategories: sub(['বেবি কট', 'স্টাডি টেবিল', 'বাংক বেড']) },
    { name: 'স্টিল ও প্লাস্টিক ফার্নিচার', icon: 'box', order: 7, subcategories: sub(['স্টিল আলমারি', 'প্লাস্টিক চেয়ার', 'প্লাস্টিক টেবিল']) },
    { name: 'দরজা ও ইন্টেরিয়র', icon: 'door-open', order: 8, subcategories: sub(['দরজা', 'পার্টিশন', 'ইন্টেরিয়র ডেকর']) },
    { name: 'ফার্নিচার এক্সেসরিজ', icon: 'wrench', order: 9, subcategories: sub(['হ্যান্ডেল ও লক', 'কব্জা', 'ফোম ও কুশন']) }
  ],

  "manufacturing": [
    { name: 'কাঁচামাল', icon: 'package-open', order: 1, subcategories: sub(['মূল কাঁচামাল', 'সহায়ক উপকরণ', 'রাসায়নিক দ্রব্য']) },
    { name: 'আধা-প্রস্তুত পণ্য', icon: 'layers', order: 2, subcategories: sub(['প্রসেসিং আইটেম', 'অসমাপ্ত পণ্য']) },
    { name: 'তৈরি পণ্য', icon: 'package-check', order: 3, subcategories: sub(['ফিনিশড গুডস', 'রেডি স্টক']) },
    { name: 'প্যাকেজিং সামগ্রী', icon: 'box', order: 4, subcategories: sub(['কার্টন', 'পলি ব্যাগ', 'লেবেল ও স্টিকার', 'বোতল ও জার']) },
    { name: 'মেশিন ও যন্ত্রাংশ', icon: 'cog', order: 5, subcategories: sub(['মেশিন পার্টস', 'স্পেয়ার পার্টস', 'টুলস']) },
    { name: 'রক্ষণাবেক্ষণ', icon: 'wrench', order: 6, subcategories: sub(['লুব্রিকেন্ট', 'মেরামত সামগ্রী']) },
    { name: 'রিজেক্ট ও স্ক্র্যাপ', icon: 'trash-2', order: 7, subcategories: sub(['রিজেক্ট পণ্য', 'স্ক্র্যাপ']) },
    { name: 'উপজাত পণ্য', icon: 'recycle', order: 8, subcategories: [] }
  ],

  "medical-surgical": [
    { name: 'সার্জিক্যাল যন্ত্রপাতি', icon: 'scissors', order: 1, subcategories: sub(['কাঁচি ও ফরসেপ', 'স্ক্যালপেল ও ব্লেড', 'সেলাই সরঞ্জাম', 'সার্জিক্যাল ট্রে']) },
    { name: 'ডিসপোজেবল আইটেম', icon: 'syringe', order: 2, subcategories: sub(['সিরিঞ্জ', 'হ্যান্ড গ্লাভস', 'মাস্ক', 'ক্যাথেটার', 'ক্যানুলা', 'স্যালাইন সেট']) },
    { name: 'ড্রেসিং ও ব্যান্ডেজ', icon: 'bandage', order: 3, subcategories: sub(['গজ ও ব্যান্ডেজ', 'তুলা', 'প্লাস্টার', 'অ্যান্টিসেপটিক']) },
    { name: 'ডায়াগনস্টিক যন্ত্র', icon: 'stethoscope', order: 4, subcategories: sub(['স্টেথোস্কোপ', 'ব্লাড প্রেশার মেশিন', 'থার্মোমিটার', 'গ্লুকোমিটার', 'পালস অক্সিমিটার']) },
    { name: 'হাসপাতাল সরঞ্জাম', icon: 'bed', order: 5, subcategories: sub(['হাসপাতাল বেড', 'হুইলচেয়ার', 'স্ট্রেচার', 'ওয়াকার', 'আইভি স্ট্যান্ড']) },
    { name: 'ল্যাব সামগ্রী', icon: 'flask-conical', order: 6, subcategories: sub(['টেস্ট টিউব', 'রিএজেন্ট', 'স্লাইড', 'ল্যাব কিট']) },
    { name: 'অর্থোপেডিক সামগ্রী', icon: 'bone', order: 7, subcategories: sub(['সাপোর্ট বেল্ট', 'নি ক্যাপ', 'সার্ভিক্যাল কলার', 'ক্রাচ']) },
    { name: 'অক্সিজেন ও থেরাপি', icon: 'wind', order: 8, subcategories: sub(['অক্সিজেন সিলিন্ডার', 'নেবুলাইজার', 'অক্সিজেন মাস্ক']) },
    { name: 'ডেন্টাল সামগ্রী', icon: 'smile', order: 9, subcategories: sub(['ডেন্টাল যন্ত্র', 'ডেন্টাল ম্যাটেরিয়াল']) }
  ],

  "mobile": [
    { name: 'মোবাইল ফোন', icon: 'smartphone', order: 1, subcategories: sub(['স্মার্টফোন', 'ফিচার ফোন', 'রিফার্বিশড ফোন']) },
    { name: 'ট্যাব ও আইপ্যাড', icon: 'tablet', order: 2, subcategories: sub(['অ্যান্ড্রয়েড ট্যাব', 'আইপ্যাড']) },
    { name: 'চার্জার ও ক্যাবল', icon: 'cable', order: 3, subcategories: sub(['চার্জার', 'ফাস্ট চার্জার', 'ডাটা ক্যাবল', 'পাওয়ার ব্যাংক']) },
    { name: 'কভার ও প্রোটেকশন', icon: 'shield', order: 4, subcategories: sub(['ব্যাক কভার', 'স্ক্রিন প্রটেক্টর', 'গ্লাস প্রটেক্টর', 'পপ সকেট']) },
    { name: 'অডিও এক্সেসরিজ', icon: 'headphones', order: 5, subcategories: sub(['হেডফোন', 'ইয়ারফোন', 'ব্লুটুথ ইয়ারবাড', 'ব্লুটুথ স্পিকার']) },
    { name: 'স্মার্ট গ্যাজেট', icon: 'watch', order: 6, subcategories: sub(['স্মার্ট ওয়াচ', 'ফিটনেস ব্যান্ড', 'স্মার্ট গ্লাস']) },
    { name: 'মোবাইল পার্টস', icon: 'cpu', order: 7, subcategories: sub(['ডিসপ্লে', 'ব্যাটারি', 'চার্জিং পোর্ট', 'ক্যামেরা']) },
    { name: 'সিম ও রিচার্জ', icon: 'signal', order: 8, subcategories: sub(['সিম কার্ড', 'রিচার্জ কার্ড', 'ইন্টারনেট প্যাক']) },
    { name: 'সার্ভিসিং', icon: 'wrench', order: 9, subcategories: sub(['মেরামত সেবা', 'সফটওয়্যার সার্ভিস']) }
  ],

  "general-trading": [
    { name: 'প্রধান পণ্য', icon: 'package', order: 1, subcategories: sub(['নিয়মিত পণ্য', 'নতুন পণ্য', 'অফার পণ্য']) },
    { name: 'পাইকারি পণ্য', icon: 'boxes', order: 2, subcategories: sub(['কার্টন', 'ডজন', 'বস্তা']) },
    { name: 'খুচরা পণ্য', icon: 'shopping-bag', order: 3, subcategories: sub(['পিস আইটেম', 'ছোট প্যাক']) },
    { name: 'কাঁচামাল ও সরবরাহ', icon: 'package-open', order: 4, subcategories: sub(['কাঁচামাল', 'প্যাকেজিং সামগ্রী']) },
    { name: 'সেবা ও চার্জ', icon: 'receipt', order: 5, subcategories: sub(['ডেলিভারি চার্জ', 'সার্ভিস চার্জ', 'ইনস্টলেশন']) },
    { name: 'অন্যান্য', icon: 'box', order: 6, subcategories: [] }
  ],

  "shoe": [
    { name: 'পুরুষদের জুতা', icon: 'footprints', order: 1, subcategories: sub(['ফরমাল সু', 'লোফার', 'স্যান্ডেল', 'স্লিপার', 'বুট']) },
    { name: 'নারীদের জুতা', icon: 'footprints', order: 2, subcategories: sub(['হিল', 'ফ্ল্যাট স্যান্ডেল', 'পাম্প সু', 'স্লিপার']) },
    { name: 'শিশুদের জুতা', icon: 'baby', order: 3, subcategories: sub(['স্কুল সু', 'বেবি সু', 'শিশু স্যান্ডেল']) },
    { name: 'স্পোর্টস ও স্নিকার্স', icon: 'activity', order: 4, subcategories: sub(['রানিং সু', 'স্নিকার্স', 'ফুটবল বুট', 'জিম সু']) },
    { name: 'স্কুল ও অফিস', icon: 'briefcase', order: 5, subcategories: sub(['স্কুল সু', 'অফিস সু']) },
    { name: 'জুতার এক্সেসরিজ', icon: 'brush', order: 6, subcategories: sub(['শু পলিশ', 'ইনসোল', 'ফিতা', 'শু ব্রাশ']) },
    { name: 'ব্যাগ ও চামড়াজাত', icon: 'backpack', order: 7, subcategories: sub(['ব্যাগ', 'বেল্ট', 'মানিব্যাগ']) }
  ],

  "supershop": [
    { name: 'চাল, ডাল ও আটা', icon: 'wheat', order: 1, subcategories: sub(['চাল', 'ডাল', 'আটা ও ময়দা', 'সুজি']) },
    { name: 'তেল, ঘি ও মসলা', icon: 'droplet', order: 2, subcategories: sub(['সয়াবিন তেল', 'সরিষার তেল', 'ঘি', 'গুঁড়া মসলা', 'আস্ত মসলা']) },
    { name: 'স্ন্যাকস ও বিস্কুট', icon: 'cookie', order: 3, subcategories: sub(['বিস্কুট', 'চিপস', 'চানাচুর', 'চকলেট ও ক্যান্ডি', 'কেক']) },
    { name: 'পানীয়', icon: 'cup-soda', order: 4, subcategories: sub(['কোমল পানীয়', 'জুস', 'পানি', 'চা ও কফি', 'এনার্জি ড্রিংক']) },
    { name: 'ডেইরি ও ফ্রোজেন', icon: 'milk', order: 5, subcategories: sub(['দুধ', 'দই ও মিষ্টি', 'পনির ও বাটার', 'আইসক্রিম', 'ফ্রোজেন ফুড']) },
    { name: 'তাজা পণ্য', icon: 'carrot', order: 6, subcategories: sub(['শাকসবজি', 'ফলমূল', 'মাছ ও মাংস', 'ডিম']) },
    { name: 'বেকারি', icon: 'croissant', order: 7, subcategories: sub(['পাউরুটি', 'বান ও কেক', 'পেস্ট্রি']) },
    { name: 'পরিষ্কার সামগ্রী', icon: 'spray-can', order: 8, subcategories: sub(['ডিটারজেন্ট', 'ডিশ ওয়াশ', 'টয়লেট ক্লিনার', 'ঝাড়ু ও মপ']) },
    { name: 'পার্সোনাল কেয়ার', icon: 'heart', order: 9, subcategories: sub(['সাবান ও শ্যাম্পু', 'টুথপেস্ট', 'স্কিন কেয়ার', 'স্যানিটারি ন্যাপকিন']) },
    { name: 'বেবি কেয়ার', icon: 'baby', order: 10, subcategories: sub(['ডায়াপার', 'বেবি ফুড', 'বেবি লোশন']) },
    { name: 'গৃহস্থালি', icon: 'home', order: 11, subcategories: sub(['কিচেন আইটেম', 'প্লাস্টিক সামগ্রী', 'টিস্যু ও ন্যাপকিন']) },
    { name: 'স্টেশনারি ও অন্যান্য', icon: 'pen', order: 12, subcategories: sub(['খাতা ও কলম', 'ব্যাটারি', 'লাইটার']) }
  ],

  "stationery": [
    { name: 'লেখার সামগ্রী', icon: 'pen', order: 1, subcategories: sub(['বলপেন', 'জেল পেন', 'পেন্সিল', 'মার্কার', 'হাইলাইটার']) },
    { name: 'খাতা ও কাগজ', icon: 'notebook', order: 2, subcategories: sub(['খাতা', 'নোটবুক', 'এ৪ কাগজ', 'ড্রয়িং খাতা', 'ডায়েরি']) },
    { name: 'অফিস সামগ্রী', icon: 'paperclip', order: 3, subcategories: sub(['ফাইল ও ফোল্ডার', 'স্ট্যাপলার', 'ক্লিপ ও পিন', 'পাঞ্চ মেশিন', 'ক্যালকুলেটর']) },
    { name: 'আর্ট ও ক্রাফট', icon: 'palette', order: 4, subcategories: sub(['রং পেন্সিল', 'জলরং', 'ব্রাশ', 'ক্রাফট পেপার', 'ক্লে']) },
    { name: 'স্কুল সামগ্রী', icon: 'backpack', order: 5, subcategories: sub(['স্কুল ব্যাগ', 'জ্যামিতি বক্স', 'টিফিন বক্স', 'পানির বোতল']) },
    { name: 'প্রিন্টিং ও কম্পিউটার', icon: 'printer', order: 6, subcategories: sub(['প্রিন্টিং পেপার', 'কার্টিজ ও টোনার', 'পেনড্রাইভ']) },
    { name: 'আঠা ও কাটিং', icon: 'scissors', order: 7, subcategories: sub(['আঠা', 'স্কচ টেপ', 'কাঁচি', 'কাটার']) },
    { name: 'গিফট ও কার্ড', icon: 'gift', order: 8, subcategories: sub(['গ্রিটিং কার্ড', 'গিফট পেপার', 'ব্যানার ও পোস্টার']) }
  ]
};

module.exports = CATEGORY_SEEDS;
