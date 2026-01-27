/**
 * Product Seeder Script
 *
 * Generates 1000 products for a shop identified by owner phone number.
 * Covers: variants, different stock levels, prices, units, barcodes, brands, etc.
 *
 * Usage: node src/seeds/productSeeder.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const User = require('../models/User.model');
const Shop = require('../models/Shop.model');
const { seedCategories } = require('./categorySeeder');

const OWNER_PHONE = '01757995016';
const TOTAL_PRODUCTS = 1000;

// ─── Helpers ──────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[rand(0, arr.length - 1)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function roundTo5(n) {
  return Math.round(n / 5) * 5;
}

function genBarcode() {
  // EAN-13 style
  let code = '880'; // Bangladesh prefix
  for (let i = 0; i < 10; i++) code += rand(0, 9);
  return code;
}

function genSku(prefix, index) {
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

// ─── Product data pools per shop type ─────────────────────────
const PRODUCT_POOLS = {
  cloth: {
    brands: ['Aarong', 'Yellow', 'Cats Eye', 'Richman', 'Easy', 'Ecstasy', 'Dorjibari', 'Lubnan', 'Le Reve', 'Sailor', 'Apex', 'Bata', 'Bay Emporium'],
    sizes: ['S', 'M', 'L', 'XL', 'XXL', '28', '30', '32', '34', '36', '38', '40', '42'],
    colors: ['সাদা', 'কালো', 'লাল', 'নীল', 'সবুজ', 'ধূসর', 'বেগুনি', 'হলুদ', 'মেরুন', 'নেভি', 'অফ-হোয়াইট', 'ক্রিম', 'গোলাপি', 'আকাশি', 'অলিভ'],
    materials: ['Cotton', 'Silk', 'Polyester', 'Linen', 'Georgette', 'Chiffon', 'Denim', 'Wool', 'Viscose'],
    products: [
      { name: 'Formal Shirt', nameBn: 'ফর্মাল শার্ট', unit: 'piece', priceRange: [350, 1800], hasVariants: true, variantType: 'size+color' },
      { name: 'Casual T-Shirt', nameBn: 'ক্যাজুয়াল টি-শার্ট', unit: 'piece', priceRange: [200, 800], hasVariants: true, variantType: 'size+color' },
      { name: 'Polo Shirt', nameBn: 'পোলো শার্ট', unit: 'piece', priceRange: [350, 1200], hasVariants: true, variantType: 'size+color' },
      { name: 'Denim Jeans', nameBn: 'ডেনিম জিন্স', unit: 'piece', priceRange: [600, 2500], hasVariants: true, variantType: 'size+color' },
      { name: 'Chino Pant', nameBn: 'চিনো প্যান্ট', unit: 'piece', priceRange: [500, 1800], hasVariants: true, variantType: 'size+color' },
      { name: 'Panjabi', nameBn: 'পাঞ্জাবি', unit: 'piece', priceRange: [600, 3500], hasVariants: true, variantType: 'size+color' },
      { name: 'Lungi', nameBn: 'লুঙ্গি', unit: 'piece', priceRange: [150, 600], hasVariants: true, variantType: 'color' },
      { name: 'Jacket', nameBn: 'জ্যাকেট', unit: 'piece', priceRange: [800, 3500], hasVariants: true, variantType: 'size+color' },
      { name: 'Sweater', nameBn: 'সোয়েটার', unit: 'piece', priceRange: [400, 2000], hasVariants: true, variantType: 'size+color' },
      { name: 'Saree Jamdani', nameBn: 'জামদানি শাড়ি', unit: 'piece', priceRange: [1500, 15000], hasVariants: true, variantType: 'color' },
      { name: 'Cotton Saree', nameBn: 'সুতি শাড়ি', unit: 'piece', priceRange: [400, 2500], hasVariants: true, variantType: 'color' },
      { name: 'Silk Saree', nameBn: 'সিল্ক শাড়ি', unit: 'piece', priceRange: [800, 5000], hasVariants: true, variantType: 'color' },
      { name: 'Salwar Kameez', nameBn: 'সালোয়ার কামিজ', unit: 'piece', priceRange: [600, 3000], hasVariants: true, variantType: 'size+color' },
      { name: 'Three Piece', nameBn: 'থ্রি-পিস', unit: 'set', priceRange: [800, 4000], hasVariants: true, variantType: 'size+color' },
      { name: 'Kurti', nameBn: 'কুর্তি', unit: 'piece', priceRange: [300, 1500], hasVariants: true, variantType: 'size+color' },
      { name: 'Borka', nameBn: 'বোরকা', unit: 'piece', priceRange: [500, 3000], hasVariants: true, variantType: 'size+color' },
      { name: 'Hijab', nameBn: 'হিজাব', unit: 'piece', priceRange: [100, 600], hasVariants: true, variantType: 'color' },
      { name: 'Boys T-Shirt', nameBn: 'ছেলেদের টি-শার্ট', unit: 'piece', priceRange: [150, 500], hasVariants: true, variantType: 'size+color' },
      { name: 'Girls Frock', nameBn: 'মেয়েদের ফ্রক', unit: 'piece', priceRange: [200, 800], hasVariants: true, variantType: 'size+color' },
      { name: 'School Uniform', nameBn: 'স্কুল ইউনিফর্ম', unit: 'set', priceRange: [300, 1000], hasVariants: true, variantType: 'size' },
      { name: 'Cotton Fabric', nameBn: 'সুতি কাপড়', unit: 'meter', priceRange: [80, 400], hasVariants: false },
      { name: 'Silk Fabric', nameBn: 'সিল্ক কাপড়', unit: 'meter', priceRange: [200, 1200], hasVariants: false },
      { name: 'Georgette Fabric', nameBn: 'জর্জেট কাপড়', unit: 'meter', priceRange: [150, 600], hasVariants: false },
      { name: 'Linen Fabric', nameBn: 'লিনেন কাপড়', unit: 'meter', priceRange: [200, 800], hasVariants: false },
      { name: 'Men Shoe Formal', nameBn: 'পুরুষ ফর্মাল জুতা', unit: 'piece', priceRange: [800, 4000], hasVariants: true, variantType: 'size+color' },
      { name: 'Women Sandal', nameBn: 'মহিলা স্যান্ডেল', unit: 'piece', priceRange: [300, 1500], hasVariants: true, variantType: 'size+color' },
      { name: 'Sneaker', nameBn: 'স্নিকার/কেডস', unit: 'piece', priceRange: [500, 3000], hasVariants: true, variantType: 'size+color' },
      { name: 'Slipper', nameBn: 'চপ্পল/স্লিপার', unit: 'piece', priceRange: [80, 400], hasVariants: true, variantType: 'size' },
      { name: 'Cap', nameBn: 'টুপি/ক্যাপ', unit: 'piece', priceRange: [100, 500], hasVariants: true, variantType: 'color' },
      { name: 'Leather Belt', nameBn: 'চামড়ার বেল্ট', unit: 'piece', priceRange: [150, 800], hasVariants: true, variantType: 'color' },
      { name: 'Scarf', nameBn: 'স্কার্ফ/ওড়না', unit: 'piece', priceRange: [80, 400], hasVariants: true, variantType: 'color' },
      { name: 'Socks Pack', nameBn: 'মোজা (৩ জোড়া)', unit: 'pack', priceRange: [60, 200], hasVariants: true, variantType: 'color' },
      { name: 'Bag Backpack', nameBn: 'ব্যাকপ্যাক ব্যাগ', unit: 'piece', priceRange: [400, 2000], hasVariants: true, variantType: 'color' },
      { name: 'Wallet', nameBn: 'মানিব্যাগ/ওয়ালেট', unit: 'piece', priceRange: [200, 1200], hasVariants: true, variantType: 'color' },
      { name: 'Gamcha', nameBn: 'গামছা', unit: 'piece', priceRange: [40, 150], hasVariants: false },
      { name: 'Thread Spool', nameBn: 'সুতার রিল', unit: 'piece', priceRange: [10, 50], hasVariants: true, variantType: 'color' },
      { name: 'Button Pack', nameBn: 'বোতাম (১২ পিস)', unit: 'pack', priceRange: [10, 80], hasVariants: false },
      { name: 'Zipper', nameBn: 'জিপার/চেইন', unit: 'piece', priceRange: [15, 60], hasVariants: true, variantType: 'size' },
      { name: 'Lace Border', nameBn: 'লেস/বর্ডার', unit: 'meter', priceRange: [20, 200], hasVariants: false },
      { name: 'Underwear Men Pack', nameBn: 'পুরুষ আন্ডারওয়্যার (৩ পিস)', unit: 'pack', priceRange: [120, 400], hasVariants: true, variantType: 'size' },
      { name: 'Towel', nameBn: 'তোয়ালে', unit: 'piece', priceRange: [100, 500], hasVariants: true, variantType: 'color' },
    ],
  },

  grocery: {
    brands: ['ACI', 'Pran', 'Radhuni', 'Fresh', 'Teer', 'Bashundhara', 'Meghna', 'BD Food', 'Olympic', 'Lux', 'Lifebuoy', 'Surf Excel', 'Wheel', 'Dettol', 'Nestlé', 'Dan Cake'],
    products: [
      { name: 'Miniket Rice 5kg', nameBn: 'মিনিকেট চাল ৫ কেজি', unit: 'pack', priceRange: [320, 420], hasVariants: false },
      { name: 'Miniket Rice 25kg', nameBn: 'মিনিকেট চাল ২৫ কেজি', unit: 'pack', priceRange: [1500, 2100], hasVariants: false },
      { name: 'Nazirshail Rice 5kg', nameBn: 'নাজিরশাইল চাল ৫ কেজি', unit: 'pack', priceRange: [350, 500], hasVariants: false },
      { name: 'Basmati Rice 1kg', nameBn: 'বাসমতি চাল ১ কেজি', unit: 'pack', priceRange: [180, 350], hasVariants: false },
      { name: 'Polao Rice 1kg', nameBn: 'পোলাও চাল ১ কেজি', unit: 'pack', priceRange: [120, 200], hasVariants: false },
      { name: 'Atap Rice 5kg', nameBn: 'আতপ চাল ৫ কেজি', unit: 'pack', priceRange: [280, 380], hasVariants: false },
      { name: 'Masoor Dal 1kg', nameBn: 'মসুর ডাল ১ কেজি', unit: 'pack', priceRange: [100, 160], hasVariants: false },
      { name: 'Mung Dal 1kg', nameBn: 'মুগ ডাল ১ কেজি', unit: 'pack', priceRange: [140, 220], hasVariants: false },
      { name: 'Cholar Dal 1kg', nameBn: 'চোলার ডাল ১ কেজি', unit: 'pack', priceRange: [100, 160], hasVariants: false },
      { name: 'Soybean Oil 5L', nameBn: 'সয়াবিন তেল ৫ লিটার', unit: 'piece', priceRange: [650, 850], hasVariants: false },
      { name: 'Soybean Oil 2L', nameBn: 'সয়াবিন তেল ২ লিটার', unit: 'piece', priceRange: [280, 360], hasVariants: false },
      { name: 'Soybean Oil 1L', nameBn: 'সয়াবিন তেল ১ লিটার', unit: 'piece', priceRange: [145, 190], hasVariants: false },
      { name: 'Mustard Oil 500ml', nameBn: 'সরিষার তেল ৫০০ মিলি', unit: 'piece', priceRange: [100, 160], hasVariants: false },
      { name: 'Turmeric Powder 200g', nameBn: 'হলুদ গুঁড়া ২০০ গ্রাম', unit: 'pack', priceRange: [40, 80], hasVariants: false },
      { name: 'Chili Powder 200g', nameBn: 'মরিচ গুঁড়া ২০০ গ্রাম', unit: 'pack', priceRange: [50, 100], hasVariants: false },
      { name: 'Cumin 100g', nameBn: 'জিরা ১০০ গ্রাম', unit: 'pack', priceRange: [40, 70], hasVariants: false },
      { name: 'Coriander Powder 100g', nameBn: 'ধনে গুঁড়া ১০০ গ্রাম', unit: 'pack', priceRange: [30, 60], hasVariants: false },
      { name: 'Mixed Spice 50g', nameBn: 'গরম মশলা ৫০ গ্রাম', unit: 'pack', priceRange: [25, 50], hasVariants: false },
      { name: 'Radhuni Mix Pack', nameBn: 'রাঁধুনি মিক্স প্যাক', unit: 'pack', priceRange: [15, 40], hasVariants: false },
      { name: 'Onion 1kg (Loose)', nameBn: 'পেঁয়াজ (খোলা) ১ কেজি', unit: 'kg', priceRange: [30, 80], hasVariants: false },
      { name: 'Garlic 250g', nameBn: 'রসুন ২৫০ গ্রাম', unit: 'pack', priceRange: [30, 60], hasVariants: false },
      { name: 'Ginger 250g', nameBn: 'আদা ২৫০ গ্রাম', unit: 'pack', priceRange: [20, 50], hasVariants: false },
      { name: 'Wheat Flour 2kg', nameBn: 'আটা ২ কেজি', unit: 'pack', priceRange: [80, 130], hasVariants: false },
      { name: 'White Flour 1kg', nameBn: 'ময়দা ১ কেজি', unit: 'pack', priceRange: [40, 70], hasVariants: false },
      { name: 'Semolina 500g', nameBn: 'সুজি ৫০০ গ্রাম', unit: 'pack', priceRange: [35, 60], hasVariants: false },
      { name: 'Sugar 1kg', nameBn: 'চিনি ১ কেজি', unit: 'pack', priceRange: [100, 140], hasVariants: false },
      { name: 'Sugar 5kg', nameBn: 'চিনি ৫ কেজি', unit: 'pack', priceRange: [480, 680], hasVariants: false },
      { name: 'Salt 1kg', nameBn: 'লবণ ১ কেজি', unit: 'pack', priceRange: [30, 50], hasVariants: false },
      { name: 'Jaggery 500g', nameBn: 'গুড় ৫০০ গ্রাম', unit: 'pack', priceRange: [50, 100], hasVariants: false },
      { name: 'Tea Leaves 200g', nameBn: 'চা পাতা ২০০ গ্রাম', unit: 'pack', priceRange: [80, 160], hasVariants: false },
      { name: 'Coffee 50g', nameBn: 'কফি ৫০ গ্রাম', unit: 'pack', priceRange: [60, 150], hasVariants: false },
      { name: 'Powdered Milk 1kg', nameBn: 'গুঁড়া দুধ ১ কেজি', unit: 'pack', priceRange: [450, 700], hasVariants: false },
      { name: 'Honey 500g', nameBn: 'মধু ৫০০ গ্রাম', unit: 'piece', priceRange: [200, 500], hasVariants: false },
      { name: 'Biscuit Pack', nameBn: 'বিস্কুট প্যাকেট', unit: 'pack', priceRange: [10, 50], hasVariants: false },
      { name: 'Chips Packet', nameBn: 'চিপস প্যাকেট', unit: 'pack', priceRange: [10, 40], hasVariants: false },
      { name: 'Chanachur 150g', nameBn: 'চানাচুর ১৫০ গ্রাম', unit: 'pack', priceRange: [20, 40], hasVariants: false },
      { name: 'Chocolate Bar', nameBn: 'চকলেট', unit: 'piece', priceRange: [20, 100], hasVariants: false },
      { name: 'Instant Noodles', nameBn: 'ইনস্ট্যান্ট নুডলস', unit: 'pack', priceRange: [15, 30], hasVariants: false },
      { name: 'Flattened Rice 500g', nameBn: 'চিড়া ৫০০ গ্রাম', unit: 'pack', priceRange: [30, 50], hasVariants: false },
      { name: 'Puffed Rice 500g', nameBn: 'মুড়ি ৫০০ গ্রাম', unit: 'pack', priceRange: [25, 40], hasVariants: false },
      { name: 'Bath Soap', nameBn: 'গোসলের সাবান', unit: 'piece', priceRange: [30, 100], hasVariants: false },
      { name: 'Laundry Soap', nameBn: 'কাপড় ধোয়ার সাবান', unit: 'piece', priceRange: [20, 60], hasVariants: false },
      { name: 'Detergent 1kg', nameBn: 'ডিটারজেন্ট ১ কেজি', unit: 'pack', priceRange: [80, 180], hasVariants: false },
      { name: 'Liquid Detergent 1L', nameBn: 'লিকুইড ডিটারজেন্ট ১ লিটার', unit: 'piece', priceRange: [150, 280], hasVariants: false },
      { name: 'Dish Wash Liquid', nameBn: 'ডিশ ওয়াশ লিকুইড', unit: 'piece', priceRange: [60, 150], hasVariants: false },
      { name: 'Floor Cleaner 1L', nameBn: 'ফ্লোর ক্লিনার ১ লিটার', unit: 'piece', priceRange: [80, 160], hasVariants: false },
      { name: 'Shampoo Bottle', nameBn: 'শ্যাম্পু বোতল', unit: 'piece', priceRange: [120, 400], hasVariants: false },
      { name: 'Shampoo Sachet', nameBn: 'শ্যাম্পু স্যাশে', unit: 'piece', priceRange: [3, 8], hasVariants: false },
      { name: 'Hair Oil 200ml', nameBn: 'চুলের তেল ২০০ মিলি', unit: 'piece', priceRange: [60, 150], hasVariants: false },
      { name: 'Cream Lotion', nameBn: 'ক্রিম/লোশন', unit: 'piece', priceRange: [80, 250], hasVariants: false },
      { name: 'Toothpaste', nameBn: 'টুথপেস্ট', unit: 'piece', priceRange: [30, 120], hasVariants: false },
      { name: 'Toothbrush', nameBn: 'টুথব্রাশ', unit: 'piece', priceRange: [20, 60], hasVariants: false },
      { name: 'Razor Pack', nameBn: 'রেজার প্যাক', unit: 'pack', priceRange: [20, 80], hasVariants: false },
      { name: 'Tissue Box', nameBn: 'টিস্যু বক্স', unit: 'box', priceRange: [40, 120], hasVariants: false },
      { name: 'Baby Cereal', nameBn: 'সেরেলাক/বেবি ফুড', unit: 'pack', priceRange: [200, 450], hasVariants: false },
      { name: 'Diaper Pack', nameBn: 'ডায়পার প্যাক', unit: 'pack', priceRange: [200, 600], hasVariants: false },
      { name: 'Condensed Milk', nameBn: 'ঘন দুধ', unit: 'piece', priceRange: [30, 60], hasVariants: false },
      { name: 'Ghee 200g', nameBn: 'ঘি ২০০ গ্রাম', unit: 'piece', priceRange: [150, 300], hasVariants: false },
      { name: 'Matchbox', nameBn: 'দিয়াশলাই', unit: 'piece', priceRange: [2, 5], hasVariants: false },
      { name: 'Battery AA Pack', nameBn: 'ব্যাটারি AA', unit: 'pack', priceRange: [20, 60], hasVariants: false },
      { name: 'Candle Pack', nameBn: 'মোমবাতি প্যাক', unit: 'pack', priceRange: [15, 30], hasVariants: false },
      { name: 'Mosquito Coil', nameBn: 'মশা মারার কয়েল', unit: 'pack', priceRange: [20, 50], hasVariants: false },
      { name: 'Water Bottle 1L', nameBn: 'পানির বোতল ১ লিটার', unit: 'piece', priceRange: [15, 25], hasVariants: false },
      { name: 'Soft Drink Can', nameBn: 'কোমল পানীয় ক্যান', unit: 'piece', priceRange: [30, 50], hasVariants: false },
      { name: 'Juice Pack 250ml', nameBn: 'জুস প্যাক ২৫০ মিলি', unit: 'piece', priceRange: [20, 35], hasVariants: false },
      { name: 'Vermicelli 200g', nameBn: 'সেমাই ২০০ গ্রাম', unit: 'pack', priceRange: [25, 50], hasVariants: false },
      { name: 'Bread Loaf', nameBn: 'পাউরুটি', unit: 'piece', priceRange: [30, 60], hasVariants: false },
      { name: 'Nuts Mixed 200g', nameBn: 'বাদাম মিক্স ২০০ গ্রাম', unit: 'pack', priceRange: [80, 200], hasVariants: false },
    ],
  },

  electronics: {
    brands: ['Samsung', 'Xiaomi', 'Realme', 'Oppo', 'Vivo', 'Walton', 'Singer', 'Havells', 'TP-Link', 'HP', 'Dell', 'Lenovo', 'Logitech', 'Anker', 'Baseus', 'Ugreen', 'JBL', 'Sony', 'LG'],
    products: [
      { name: 'Smartphone 4/64', nameBn: 'স্মার্টফোন ৪/৬৪', unit: 'piece', priceRange: [8000, 15000], hasVariants: true, variantType: 'color' },
      { name: 'Smartphone 6/128', nameBn: 'স্মার্টফোন ৬/১২৮', unit: 'piece', priceRange: [14000, 25000], hasVariants: true, variantType: 'color' },
      { name: 'Smartphone 8/256', nameBn: 'স্মার্টফোন ৮/২৫৬', unit: 'piece', priceRange: [22000, 45000], hasVariants: true, variantType: 'color' },
      { name: 'Feature Phone', nameBn: 'ফিচার ফোন', unit: 'piece', priceRange: [1200, 3000], hasVariants: true, variantType: 'color' },
      { name: 'Smartwatch', nameBn: 'স্মার্টওয়াচ', unit: 'piece', priceRange: [1500, 8000], hasVariants: true, variantType: 'color' },
      { name: 'USB Charger 20W', nameBn: 'চার্জার ২০ ওয়াট', unit: 'piece', priceRange: [250, 800], hasVariants: false },
      { name: 'USB Charger 65W', nameBn: 'চার্জার ৬৫ ওয়াট', unit: 'piece', priceRange: [600, 1500], hasVariants: false },
      { name: 'USB-C Cable 1m', nameBn: 'USB-C ক্যাবল ১ মিটার', unit: 'piece', priceRange: [80, 300], hasVariants: false },
      { name: 'Lightning Cable', nameBn: 'লাইটনিং ক্যাবল', unit: 'piece', priceRange: [150, 500], hasVariants: false },
      { name: 'Wired Earphone', nameBn: 'ওয়্যার্ড ইয়ারফোন', unit: 'piece', priceRange: [100, 500], hasVariants: true, variantType: 'color' },
      { name: 'Bluetooth Earbuds', nameBn: 'ব্লুটুথ ইয়ারবাডস', unit: 'piece', priceRange: [500, 3000], hasVariants: true, variantType: 'color' },
      { name: 'Headphone', nameBn: 'হেডফোন', unit: 'piece', priceRange: [300, 2000], hasVariants: true, variantType: 'color' },
      { name: 'Phone Case TPU', nameBn: 'ফোন কেস TPU', unit: 'piece', priceRange: [50, 200], hasVariants: true, variantType: 'color' },
      { name: 'Screen Protector', nameBn: 'স্ক্রিন প্রটেক্টর', unit: 'piece', priceRange: [50, 300], hasVariants: false },
      { name: 'Power Bank 10000mAh', nameBn: 'পাওয়ার ব্যাংক ১০০০০', unit: 'piece', priceRange: [600, 1500], hasVariants: true, variantType: 'color' },
      { name: 'Power Bank 20000mAh', nameBn: 'পাওয়ার ব্যাংক ২০০০০', unit: 'piece', priceRange: [1000, 2500], hasVariants: true, variantType: 'color' },
      { name: 'Bluetooth Speaker', nameBn: 'ব্লুটুথ স্পিকার', unit: 'piece', priceRange: [500, 3000], hasVariants: true, variantType: 'color' },
      { name: 'Memory Card 32GB', nameBn: 'মেমোরি কার্ড ৩২ জিবি', unit: 'piece', priceRange: [250, 400], hasVariants: false },
      { name: 'Memory Card 64GB', nameBn: 'মেমোরি কার্ড ৬৪ জিবি', unit: 'piece', priceRange: [400, 650], hasVariants: false },
      { name: 'Phone Holder', nameBn: 'ফোন হোল্ডার/স্ট্যান্ড', unit: 'piece', priceRange: [100, 400], hasVariants: false },
      { name: 'Wireless Mouse', nameBn: 'ওয়্যারলেস মাউস', unit: 'piece', priceRange: [250, 800], hasVariants: true, variantType: 'color' },
      { name: 'Mechanical Keyboard', nameBn: 'মেকানিক্যাল কিবোর্ড', unit: 'piece', priceRange: [800, 3000], hasVariants: true, variantType: 'color' },
      { name: 'Pen Drive 32GB', nameBn: 'পেনড্রাইভ ৩২ জিবি', unit: 'piece', priceRange: [200, 400], hasVariants: false },
      { name: 'Pen Drive 64GB', nameBn: 'পেনড্রাইভ ৬৪ জিবি', unit: 'piece', priceRange: [350, 600], hasVariants: false },
      { name: 'Webcam HD', nameBn: 'ওয়েবক্যাম HD', unit: 'piece', priceRange: [500, 2000], hasVariants: false },
      { name: 'Mouse Pad', nameBn: 'মাউস প্যাড', unit: 'piece', priceRange: [80, 300], hasVariants: true, variantType: 'color' },
      { name: 'USB Hub 4-Port', nameBn: 'USB হাব ৪ পোর্ট', unit: 'piece', priceRange: [200, 600], hasVariants: false },
      { name: 'LED Bulb 12W', nameBn: 'LED বাল্ব ১২ ওয়াট', unit: 'piece', priceRange: [50, 120], hasVariants: false },
      { name: 'LED Bulb 18W', nameBn: 'LED বাল্ব ১৮ ওয়াট', unit: 'piece', priceRange: [80, 160], hasVariants: false },
      { name: 'Table Fan', nameBn: 'টেবিল ফ্যান', unit: 'piece', priceRange: [800, 2500], hasVariants: true, variantType: 'color' },
      { name: 'Ceiling Fan', nameBn: 'সিলিং ফ্যান', unit: 'piece', priceRange: [1200, 4000], hasVariants: true, variantType: 'color' },
      { name: 'Iron Press', nameBn: 'আয়রন/ইস্ত্রি', unit: 'piece', priceRange: [500, 1500], hasVariants: false },
      { name: 'Electric Kettle', nameBn: 'ইলেকট্রিক কেটলি', unit: 'piece', priceRange: [500, 1500], hasVariants: false },
      { name: 'Rice Cooker 2.8L', nameBn: 'রাইস কুকার ২.৮ লি.', unit: 'piece', priceRange: [1500, 3500], hasVariants: false },
      { name: 'Blender', nameBn: 'ব্লেন্ডার', unit: 'piece', priceRange: [1200, 3000], hasVariants: false },
      { name: 'Extension Board', nameBn: 'মাল্টিপ্লাগ/এক্সটেনশন', unit: 'piece', priceRange: [150, 500], hasVariants: false },
      { name: 'CCTV Camera', nameBn: 'সিসিটিভি ক্যামেরা', unit: 'piece', priceRange: [1500, 5000], hasVariants: false },
      { name: 'WiFi Router', nameBn: 'ওয়াইফাই রাউটার', unit: 'piece', priceRange: [800, 3000], hasVariants: false },
      { name: 'Network Cable Cat6', nameBn: 'নেটওয়ার্ক ক্যাবল Cat6', unit: 'meter', priceRange: [10, 25], hasVariants: false },
      { name: 'RJ45 Connector', nameBn: 'RJ45 কানেক্টর', unit: 'piece', priceRange: [5, 15], hasVariants: false },
    ],
  },

  pharmacy: {
    brands: ['Square', 'Beximco', 'Incepta', 'Renata', 'ACI', 'Eskayef', 'Opsonin', 'Acme', 'Aristopharma', 'Healthcare'],
    products: [
      { name: 'Napa 500mg', nameBn: 'নাপা ৫০০ মি.গ্রা.', unit: 'piece', priceRange: [1, 2], hasVariants: false },
      { name: 'Napa Extra', nameBn: 'নাপা এক্সট্রা', unit: 'piece', priceRange: [3, 5], hasVariants: false },
      { name: 'Ace 500mg', nameBn: 'এস ৫০০ মি.গ্রা.', unit: 'piece', priceRange: [1, 2], hasVariants: false },
      { name: 'Amoxicillin 500mg', nameBn: 'অ্যামোক্সিসিলিন ৫০০', unit: 'piece', priceRange: [4, 8], hasVariants: false },
      { name: 'Azithromycin 500mg', nameBn: 'অ্যাজিথ্রোমাইসিন ৫০০', unit: 'piece', priceRange: [15, 25], hasVariants: false },
      { name: 'Ciprofloxacin 500mg', nameBn: 'সিপ্রোফ্লক্সাসিন ৫০০', unit: 'piece', priceRange: [5, 10], hasVariants: false },
      { name: 'Seclo 20mg', nameBn: 'সেক্লো ২০ মি.গ্রা.', unit: 'piece', priceRange: [5, 8], hasVariants: false },
      { name: 'Fexo 120mg', nameBn: 'ফেক্সো ১২০ মি.গ্রা.', unit: 'piece', priceRange: [6, 10], hasVariants: false },
      { name: 'Losartan 50mg', nameBn: 'লোসারটান ৫০ মি.গ্রা.', unit: 'piece', priceRange: [4, 7], hasVariants: false },
      { name: 'Metformin 500mg', nameBn: 'মেটফরমিন ৫০০ মি.গ্রা.', unit: 'piece', priceRange: [2, 5], hasVariants: false },
      { name: 'Aspirin 75mg', nameBn: 'অ্যাসপিরিন ৭৫ মি.গ্রা.', unit: 'piece', priceRange: [1, 3], hasVariants: false },
      { name: 'Cough Syrup 100ml', nameBn: 'কাশির সিরাপ ১০০ মিলি', unit: 'piece', priceRange: [40, 80], hasVariants: false },
      { name: 'Antacid Syrup 200ml', nameBn: 'অ্যান্টাসিড সিরাপ ২০০ মিলি', unit: 'piece', priceRange: [50, 100], hasVariants: false },
      { name: 'Vitamin D3 Drop', nameBn: 'ভিটামিন D3 ড্রপ', unit: 'piece', priceRange: [100, 200], hasVariants: false },
      { name: 'Saline 500ml', nameBn: 'স্যালাইন ৫০০ মিলি', unit: 'piece', priceRange: [40, 70], hasVariants: false },
      { name: 'ORS Sachet', nameBn: 'ওআরএস স্যাশে', unit: 'piece', priceRange: [5, 10], hasVariants: false },
      { name: 'Eye Drop 10ml', nameBn: 'চোখের ড্রপ ১০ মিলি', unit: 'piece', priceRange: [30, 80], hasVariants: false },
      { name: 'Ointment Tube 15g', nameBn: 'মলম টিউব ১৫ গ্রাম', unit: 'piece', priceRange: [30, 100], hasVariants: false },
      { name: 'Nasal Spray', nameBn: 'নাকের স্প্রে', unit: 'piece', priceRange: [60, 150], hasVariants: false },
      { name: 'Multivitamin Tablet', nameBn: 'মাল্টিভিটামিন ট্যাবলেট', unit: 'piece', priceRange: [5, 12], hasVariants: false },
      { name: 'Vitamin C 500mg', nameBn: 'ভিটামিন সি ৫০০ মি.গ্রা.', unit: 'piece', priceRange: [3, 7], hasVariants: false },
      { name: 'Calcium D Tablet', nameBn: 'ক্যালসিয়াম-ডি ট্যাবলেট', unit: 'piece', priceRange: [4, 8], hasVariants: false },
      { name: 'Iron Capsule', nameBn: 'আয়রন ক্যাপসুল', unit: 'piece', priceRange: [3, 6], hasVariants: false },
      { name: 'Zinc Tablet', nameBn: 'জিংক ট্যাবলেট', unit: 'piece', priceRange: [2, 5], hasVariants: false },
      { name: 'Omega 3 Capsule', nameBn: 'ওমেগা ৩ ক্যাপসুল', unit: 'piece', priceRange: [8, 15], hasVariants: false },
      { name: 'Bandage Roll', nameBn: 'ব্যান্ডেজ রোল', unit: 'piece', priceRange: [15, 40], hasVariants: false },
      { name: 'Gauze Pad', nameBn: 'গজ প্যাড', unit: 'pack', priceRange: [20, 50], hasVariants: false },
      { name: 'Band Aid Box', nameBn: 'ব্যান্ড এইড বক্স', unit: 'box', priceRange: [30, 80], hasVariants: false },
      { name: 'Cotton Roll 100g', nameBn: 'তুলা ১০০ গ্রাম', unit: 'piece', priceRange: [30, 60], hasVariants: false },
      { name: 'Antiseptic Liquid', nameBn: 'অ্যান্টিসেপটিক তরল', unit: 'piece', priceRange: [50, 120], hasVariants: false },
      { name: 'Hand Sanitizer', nameBn: 'হ্যান্ড স্যানিটাইজার', unit: 'piece', priceRange: [40, 120], hasVariants: false },
      { name: 'Surgical Mask 50pc', nameBn: 'সার্জিক্যাল মাস্ক ৫০ পিস', unit: 'box', priceRange: [100, 200], hasVariants: false },
      { name: 'Digital Thermometer', nameBn: 'ডিজিটাল থার্মোমিটার', unit: 'piece', priceRange: [100, 300], hasVariants: false },
      { name: 'BP Machine Digital', nameBn: 'ডিজিটাল বিপি মেশিন', unit: 'piece', priceRange: [1200, 3000], hasVariants: false },
      { name: 'Glucometer Kit', nameBn: 'গ্লুকোমিটার কিট', unit: 'piece', priceRange: [800, 2000], hasVariants: false },
      { name: 'Pulse Oximeter', nameBn: 'পালস অক্সিমিটার', unit: 'piece', priceRange: [500, 1500], hasVariants: false },
      { name: 'Test Strip 50pc', nameBn: 'টেস্ট স্ট্রিপ ৫০ পিস', unit: 'box', priceRange: [400, 800], hasVariants: false },
      { name: 'Syringe 5ml', nameBn: 'সিরিঞ্জ ৫ মিলি', unit: 'piece', priceRange: [8, 15], hasVariants: false },
      { name: 'Baby Vitamin Drop', nameBn: 'বেবি ভিটামিন ড্রপ', unit: 'piece', priceRange: [80, 180], hasVariants: false },
      { name: 'Gripe Water', nameBn: 'গ্রাইপ ওয়াটার', unit: 'piece', priceRange: [60, 120], hasVariants: false },
      { name: 'Sanitary Napkin', nameBn: 'স্যানিটারি ন্যাপকিন', unit: 'pack', priceRange: [40, 120], hasVariants: false },
      { name: 'Pregnancy Test Kit', nameBn: 'প্রেগন্যান্সি টেস্ট কিট', unit: 'piece', priceRange: [30, 80], hasVariants: false },
      { name: 'Toothpaste', nameBn: 'টুথপেস্ট', unit: 'piece', priceRange: [30, 120], hasVariants: false },
      { name: 'Face Wash', nameBn: 'ফেসওয়াশ', unit: 'piece', priceRange: [80, 250], hasVariants: false },
      { name: 'Body Lotion', nameBn: 'বডি লোশন', unit: 'piece', priceRange: [100, 300], hasVariants: false },
    ],
  },

  // For hardware, cosmetics, bookshop, other — use a generic mix
  _default: {
    brands: ['Generic', 'Local Brand', 'Premium', 'Standard', 'Economy', 'Gold Star', 'Super', 'Royal', 'Diamond', 'Classic'],
    products: [
      { name: 'Product A', nameBn: 'পণ্য A', unit: 'piece', priceRange: [50, 500], hasVariants: false },
      { name: 'Product B', nameBn: 'পণ্য B', unit: 'piece', priceRange: [100, 1000], hasVariants: true, variantType: 'size' },
      { name: 'Product C', nameBn: 'পণ্য C', unit: 'kg', priceRange: [50, 300], hasVariants: false },
      { name: 'Product D', nameBn: 'পণ্য D', unit: 'piece', priceRange: [200, 2000], hasVariants: true, variantType: 'color' },
      { name: 'Product E', nameBn: 'পণ্য E', unit: 'pack', priceRange: [30, 200], hasVariants: false },
      { name: 'Product F', nameBn: 'পণ্য F', unit: 'piece', priceRange: [500, 5000], hasVariants: true, variantType: 'size+color' },
      { name: 'Product G', nameBn: 'পণ্য G', unit: 'meter', priceRange: [20, 150], hasVariants: false },
      { name: 'Product H', nameBn: 'পণ্য H', unit: 'box', priceRange: [100, 800], hasVariants: false },
      { name: 'Product I', nameBn: 'পণ্য I', unit: 'set', priceRange: [300, 3000], hasVariants: true, variantType: 'size' },
      { name: 'Product J', nameBn: 'পণ্য J', unit: 'dozen', priceRange: [60, 600], hasVariants: false },
    ],
  },
};

// ─── Hardware-specific products ───────────────────────────────
PRODUCT_POOLS.hardware = {
  brands: ['Stanley', 'Bosch', 'Berger', 'Asian Paints', 'RFL', 'National', 'Walton', 'BBS', 'Elite', 'Shah Cement'],
  products: [
    { name: 'Claw Hammer', nameBn: 'ক্ল হাতুড়ি', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'Combination Plier', nameBn: 'কম্বিনেশন প্লায়ার্স', unit: 'piece', priceRange: [100, 400], hasVariants: false },
    { name: 'Screwdriver Set', nameBn: 'স্ক্রু ড্রাইভার সেট', unit: 'set', priceRange: [150, 600], hasVariants: false },
    { name: 'Adjustable Wrench 8"', nameBn: 'অ্যাডজাস্টেবল রেঞ্চ ৮"', unit: 'piece', priceRange: [150, 500], hasVariants: false },
    { name: 'Utility Knife', nameBn: 'ইউটিলিটি কাটার', unit: 'piece', priceRange: [30, 120], hasVariants: false },
    { name: 'Measuring Tape 5m', nameBn: 'মাপার ফিতা ৫ মিটার', unit: 'piece', priceRange: [60, 200], hasVariants: false },
    { name: 'Spirit Level 12"', nameBn: 'স্পিরিট লেভেল ১২"', unit: 'piece', priceRange: [100, 400], hasVariants: false },
    { name: 'Hacksaw Frame', nameBn: 'হ্যাকস ফ্রেম', unit: 'piece', priceRange: [100, 350], hasVariants: false },
    { name: 'Drill Machine 13mm', nameBn: 'ড্রিল মেশিন ১৩ মিলি', unit: 'piece', priceRange: [2000, 5000], hasVariants: false },
    { name: 'Tool Box', nameBn: 'টুল বক্স', unit: 'piece', priceRange: [300, 1200], hasVariants: false },
    { name: 'Electric Wire 1.5mm (100m)', nameBn: 'ইলেকট্রিক তার ১.৫ মিলি (১০০ মি.)', unit: 'piece', priceRange: [1200, 2000], hasVariants: false },
    { name: 'Switch Board', nameBn: 'সুইচ বোর্ড', unit: 'piece', priceRange: [30, 150], hasVariants: false },
    { name: 'Socket 2-Pin', nameBn: 'সকেট ২-পিন', unit: 'piece', priceRange: [20, 60], hasVariants: false },
    { name: 'Circuit Breaker 32A', nameBn: 'সার্কিট ব্রেকার ৩২ এম্পিয়ার', unit: 'piece', priceRange: [200, 500], hasVariants: false },
    { name: 'LED Bulb 9W', nameBn: 'LED বাল্ব ৯ ওয়াট', unit: 'piece', priceRange: [40, 100], hasVariants: false },
    { name: 'Tube Light 36W', nameBn: 'টিউব লাইট ৩৬ ওয়াট', unit: 'piece', priceRange: [150, 400], hasVariants: false },
    { name: 'PVC Pipe 1" (10ft)', nameBn: 'পিভিসি পাইপ ১" (১০ ফুট)', unit: 'piece', priceRange: [60, 150], hasVariants: false },
    { name: 'GI Pipe 1" (10ft)', nameBn: 'জিআই পাইপ ১" (১০ ফুট)', unit: 'piece', priceRange: [200, 500], hasVariants: false },
    { name: 'PVC Elbow 1"', nameBn: 'পিভিসি এলবো ১"', unit: 'piece', priceRange: [10, 30], hasVariants: false },
    { name: 'Water Tap', nameBn: 'পানির কল', unit: 'piece', priceRange: [100, 500], hasVariants: false },
    { name: 'Ball Valve 1/2"', nameBn: 'বল ভালভ ১/২"', unit: 'piece', priceRange: [80, 250], hasVariants: false },
    { name: 'Wall Paint 1 Gallon', nameBn: 'দেয়ালের রং ১ গ্যালন', unit: 'piece', priceRange: [500, 1500], hasVariants: true, variantType: 'color' },
    { name: 'Wood Varnish 1L', nameBn: 'কাঠের বার্নিশ ১ লিটার', unit: 'piece', priceRange: [200, 500], hasVariants: false },
    { name: 'Spray Paint Can', nameBn: 'স্প্রে পেইন্ট ক্যান', unit: 'piece', priceRange: [150, 350], hasVariants: true, variantType: 'color' },
    { name: 'Putty 5kg', nameBn: 'পুটি ৫ কেজি', unit: 'piece', priceRange: [200, 400], hasVariants: false },
    { name: 'Super Glue', nameBn: 'সুপার গ্লু', unit: 'piece', priceRange: [20, 80], hasVariants: false },
    { name: 'Paint Brush 4"', nameBn: 'পেইন্ট ব্রাশ ৪"', unit: 'piece', priceRange: [30, 100], hasVariants: false },
    { name: 'Padlock 50mm', nameBn: 'তালা ৫০ মিলি', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'Door Lock Set', nameBn: 'দরজার লক সেট', unit: 'set', priceRange: [300, 1500], hasVariants: false },
    { name: 'Door Hinge 4"', nameBn: 'কব্জা ৪"', unit: 'piece', priceRange: [30, 100], hasVariants: false },
    { name: 'Door Handle', nameBn: 'দরজার হ্যান্ডেল', unit: 'piece', priceRange: [100, 500], hasVariants: false },
    { name: 'Shower Set', nameBn: 'শাওয়ার সেট', unit: 'set', priceRange: [500, 2000], hasVariants: false },
    { name: 'Cement 50kg', nameBn: 'সিমেন্ট ৫০ কেজি', unit: 'piece', priceRange: [450, 600], hasVariants: false },
    { name: 'MS Rod 10mm', nameBn: 'রড ১০ মিলি', unit: 'piece', priceRange: [500, 800], hasVariants: false },
    { name: 'Tiles 60x60cm', nameBn: 'টাইলস ৬০x৬০ সেমি', unit: 'piece', priceRange: [50, 200], hasVariants: true, variantType: 'color' },
    { name: 'Nut-Bolt Pack', nameBn: 'নাট-বোল্ট প্যাক', unit: 'pack', priceRange: [20, 80], hasVariants: true, variantType: 'size' },
    { name: 'Wood Screw Pack', nameBn: 'কাঠের স্ক্রু প্যাক', unit: 'pack', priceRange: [15, 60], hasVariants: true, variantType: 'size' },
    { name: 'Nylon Rope 10m', nameBn: 'নাইলনের দড়ি ১০ মিটার', unit: 'piece', priceRange: [40, 120], hasVariants: false },
    { name: 'GI Wire Mesh 1sqm', nameBn: 'জিআই তারজালি ১ বর্গ মিটার', unit: 'piece', priceRange: [100, 300], hasVariants: false },
    { name: 'Insulation Tape', nameBn: 'ইনসুলেশন টেপ', unit: 'piece', priceRange: [15, 40], hasVariants: true, variantType: 'color' },
  ],
};

PRODUCT_POOLS.cosmetics = {
  brands: ['Maybelline', 'Loreal', 'Revlon', 'Lakme', 'The Body Shop', 'Neutrogena', 'Nivea', 'Garnier', 'Pond\'s', 'Fair & Lovely', 'TRESemmé', 'Dove', 'Vaseline'],
  colors: ['Red', 'Pink', 'Nude', 'Berry', 'Coral', 'Brown', 'Plum', 'Mauve', 'Orange', 'Peach'],
  products: [
    { name: 'Face Wash Gel', nameBn: 'ফেসওয়াশ জেল', unit: 'piece', priceRange: [120, 400], hasVariants: false },
    { name: 'Cleanser Milk', nameBn: 'ক্লিনজার মিল্ক', unit: 'piece', priceRange: [150, 500], hasVariants: false },
    { name: 'Toner Water', nameBn: 'টোনার ওয়াটার', unit: 'piece', priceRange: [200, 600], hasVariants: false },
    { name: 'Serum Vitamin C', nameBn: 'ভিটামিন সি সিরাম', unit: 'piece', priceRange: [300, 1000], hasVariants: false },
    { name: 'Moisturizer Cream', nameBn: 'ময়েশ্চারাইজার ক্রিম', unit: 'piece', priceRange: [150, 600], hasVariants: false },
    { name: 'Sunscreen SPF50', nameBn: 'সানস্ক্রিন SPF50', unit: 'piece', priceRange: [250, 800], hasVariants: false },
    { name: 'Night Cream', nameBn: 'নাইট ক্রিম', unit: 'piece', priceRange: [200, 700], hasVariants: false },
    { name: 'Face Mask Sheet', nameBn: 'ফেস মাস্ক শিট', unit: 'piece', priceRange: [50, 150], hasVariants: false },
    { name: 'Lip Balm', nameBn: 'লিপ বাম', unit: 'piece', priceRange: [80, 250], hasVariants: false },
    { name: 'Foundation Liquid', nameBn: 'লিকুইড ফাউন্ডেশন', unit: 'piece', priceRange: [300, 1200], hasVariants: true, variantType: 'color' },
    { name: 'Compact Powder', nameBn: 'কম্প্যাক্ট পাউডার', unit: 'piece', priceRange: [150, 600], hasVariants: true, variantType: 'color' },
    { name: 'Lipstick Matte', nameBn: 'ম্যাট লিপস্টিক', unit: 'piece', priceRange: [100, 500], hasVariants: true, variantType: 'color' },
    { name: 'Lip Gloss', nameBn: 'লিপ গ্লস', unit: 'piece', priceRange: [80, 350], hasVariants: true, variantType: 'color' },
    { name: 'Eyeliner Pen', nameBn: 'আইলাইনার পেন', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'Kajal Pencil', nameBn: 'কাজল পেন্সিল', unit: 'piece', priceRange: [50, 200], hasVariants: false },
    { name: 'Mascara', nameBn: 'মাসকারা', unit: 'piece', priceRange: [100, 500], hasVariants: false },
    { name: 'Eye Shadow Palette', nameBn: 'আই শ্যাডো প্যালেট', unit: 'piece', priceRange: [200, 800], hasVariants: false },
    { name: 'Blush On', nameBn: 'ব্লাশ অন', unit: 'piece', priceRange: [150, 500], hasVariants: true, variantType: 'color' },
    { name: 'Primer', nameBn: 'প্রাইমার', unit: 'piece', priceRange: [200, 600], hasVariants: false },
    { name: 'Makeup Remover', nameBn: 'মেকআপ রিমুভার', unit: 'piece', priceRange: [150, 400], hasVariants: false },
    { name: 'Shampoo 400ml', nameBn: 'শ্যাম্পু ৪০০ মিলি', unit: 'piece', priceRange: [200, 500], hasVariants: false },
    { name: 'Conditioner 200ml', nameBn: 'কন্ডিশনার ২০০ মিলি', unit: 'piece', priceRange: [200, 450], hasVariants: false },
    { name: 'Hair Oil 200ml', nameBn: 'হেয়ার অয়েল ২০০ মিলি', unit: 'piece', priceRange: [100, 350], hasVariants: false },
    { name: 'Hair Serum', nameBn: 'হেয়ার সিরাম', unit: 'piece', priceRange: [200, 600], hasVariants: false },
    { name: 'Hair Gel', nameBn: 'হেয়ার জেল', unit: 'piece', priceRange: [100, 300], hasVariants: false },
    { name: 'Hair Color Box', nameBn: 'হেয়ার কালার বক্স', unit: 'box', priceRange: [150, 500], hasVariants: true, variantType: 'color' },
    { name: 'Body Lotion 200ml', nameBn: 'বডি লোশন ২০০ মিলি', unit: 'piece', priceRange: [150, 400], hasVariants: false },
    { name: 'Body Wash 250ml', nameBn: 'বডি ওয়াশ ২৫০ মিলি', unit: 'piece', priceRange: [150, 400], hasVariants: false },
    { name: 'Soap Bar', nameBn: 'সাবান বার', unit: 'piece', priceRange: [30, 100], hasVariants: false },
    { name: 'Body Spray Men', nameBn: 'বডি স্প্রে পুরুষ', unit: 'piece', priceRange: [200, 600], hasVariants: false },
    { name: 'Body Spray Women', nameBn: 'বডি স্প্রে মহিলা', unit: 'piece', priceRange: [200, 600], hasVariants: false },
    { name: 'Perfume 100ml', nameBn: 'পারফিউম ১০০ মিলি', unit: 'piece', priceRange: [500, 3000], hasVariants: false },
    { name: 'Attar 6ml', nameBn: 'আতর ৬ মিলি', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'Nail Polish', nameBn: 'নেইল পলিশ', unit: 'piece', priceRange: [50, 200], hasVariants: true, variantType: 'color' },
    { name: 'Shaving Cream', nameBn: 'শেভিং ক্রিম', unit: 'piece', priceRange: [60, 200], hasVariants: false },
    { name: 'After Shave', nameBn: 'আফটার শেভ', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'Trimmer Electric', nameBn: 'ইলেকট্রিক ট্রিমার', unit: 'piece', priceRange: [500, 2000], hasVariants: false },
    { name: 'Makeup Brush Set', nameBn: 'মেকআপ ব্রাশ সেট', unit: 'set', priceRange: [200, 800], hasVariants: false },
    { name: 'Hair Dryer', nameBn: 'হেয়ার ড্রায়ার', unit: 'piece', priceRange: [500, 2000], hasVariants: false },
    { name: 'Hair Straightener', nameBn: 'স্ট্রেইটনার', unit: 'piece', priceRange: [500, 2500], hasVariants: false },
  ],
};

PRODUCT_POOLS.bookshop = {
  brands: ['Hatem Tai', 'Bengal', 'Matador', 'Dollar', 'Pilot', 'Faber-Castell', 'Camel', 'Doel', 'Fresh'],
  products: [
    { name: 'Bangla Grammar Class 9-10', nameBn: 'বাংলা ব্যাকরণ ৯-১০', unit: 'piece', priceRange: [150, 300], hasVariants: false },
    { name: 'Math Book Class 8', nameBn: 'গণিত বই ক্লাস ৮', unit: 'piece', priceRange: [200, 400], hasVariants: false },
    { name: 'English Grammar', nameBn: 'ইংরেজি গ্রামার', unit: 'piece', priceRange: [150, 350], hasVariants: false },
    { name: 'Physics HSC', nameBn: 'পদার্থবিজ্ঞান HSC', unit: 'piece', priceRange: [250, 500], hasVariants: false },
    { name: 'Chemistry HSC', nameBn: 'রসায়ন HSC', unit: 'piece', priceRange: [250, 500], hasVariants: false },
    { name: 'Biology HSC', nameBn: 'জীববিজ্ঞান HSC', unit: 'piece', priceRange: [250, 500], hasVariants: false },
    { name: 'ICT Book', nameBn: 'ICT বই', unit: 'piece', priceRange: [200, 400], hasVariants: false },
    { name: 'Exercise Copy 120pg', nameBn: 'এক্সারসাইজ খাতা ১২০ পৃষ্ঠা', unit: 'piece', priceRange: [25, 50], hasVariants: false },
    { name: 'Exercise Copy 200pg', nameBn: 'এক্সারসাইজ খাতা ২০০ পৃষ্ঠা', unit: 'piece', priceRange: [40, 70], hasVariants: false },
    { name: 'Drawing Copy A4', nameBn: 'ড্রয়িং খাতা A4', unit: 'piece', priceRange: [30, 60], hasVariants: false },
    { name: 'Lab Copy', nameBn: 'ল্যাব খাতা', unit: 'piece', priceRange: [30, 50], hasVariants: false },
    { name: 'Ball Pen Blue', nameBn: 'বল পয়েন্ট পেন নীল', unit: 'piece', priceRange: [5, 20], hasVariants: false },
    { name: 'Ball Pen Black', nameBn: 'বল পয়েন্ট পেন কালো', unit: 'piece', priceRange: [5, 20], hasVariants: false },
    { name: 'Gel Pen', nameBn: 'জেল পেন', unit: 'piece', priceRange: [15, 50], hasVariants: true, variantType: 'color' },
    { name: 'Pencil HB', nameBn: 'পেন্সিল HB', unit: 'piece', priceRange: [5, 15], hasVariants: false },
    { name: 'Mechanical Pencil 0.5', nameBn: 'মেকানিক্যাল পেন্সিল ০.৫', unit: 'piece', priceRange: [20, 60], hasVariants: false },
    { name: 'Eraser', nameBn: 'রাবার/ইরেজার', unit: 'piece', priceRange: [5, 15], hasVariants: false },
    { name: 'Sharpener', nameBn: 'শার্পনার', unit: 'piece', priceRange: [5, 20], hasVariants: false },
    { name: 'Scale 12"', nameBn: 'স্কেল ১২"', unit: 'piece', priceRange: [10, 30], hasVariants: false },
    { name: 'Geometry Box', nameBn: 'জ্যামিতি বক্স', unit: 'set', priceRange: [40, 120], hasVariants: false },
    { name: 'Bengali Novel', nameBn: 'বাংলা উপন্যাস', unit: 'piece', priceRange: [100, 400], hasVariants: false },
    { name: 'Translation Novel', nameBn: 'অনুবাদ উপন্যাস', unit: 'piece', priceRange: [150, 500], hasVariants: false },
    { name: 'Children Story Book', nameBn: 'শিশু গল্পের বই', unit: 'piece', priceRange: [50, 200], hasVariants: false },
    { name: 'Dictionary Eng-Bn', nameBn: 'ইংরেজি-বাংলা অভিধান', unit: 'piece', priceRange: [100, 400], hasVariants: false },
    { name: 'Guide Book SSC', nameBn: 'গাইড বই SSC', unit: 'piece', priceRange: [200, 500], hasVariants: false },
    { name: 'Question Bank HSC', nameBn: 'প্রশ্নব্যাংক HSC', unit: 'piece', priceRange: [150, 350], hasVariants: false },
    { name: 'School Bag', nameBn: 'স্কুল ব্যাগ', unit: 'piece', priceRange: [300, 1200], hasVariants: true, variantType: 'color' },
    { name: 'Tiffin Box', nameBn: 'টিফিন বক্স', unit: 'piece', priceRange: [80, 300], hasVariants: true, variantType: 'color' },
    { name: 'Water Bottle 500ml', nameBn: 'পানির বোতল ৫০০ মিলি', unit: 'piece', priceRange: [50, 200], hasVariants: true, variantType: 'color' },
    { name: 'Pencil Box', nameBn: 'পেন্সিল বক্স', unit: 'piece', priceRange: [30, 150], hasVariants: true, variantType: 'color' },
    { name: 'Watercolor Set', nameBn: 'ওয়াটার কালার সেট', unit: 'set', priceRange: [50, 200], hasVariants: false },
    { name: 'Color Pencil 12pc', nameBn: 'কালার পেন্সিল ১২ পিস', unit: 'set', priceRange: [30, 120], hasVariants: false },
    { name: 'Craft Paper Pack', nameBn: 'ক্রাফট পেপার প্যাক', unit: 'pack', priceRange: [20, 60], hasVariants: false },
    { name: 'Glue Stick', nameBn: 'গ্লু স্টিক', unit: 'piece', priceRange: [15, 40], hasVariants: false },
    { name: 'Quran Arabic', nameBn: 'কুরআন আরবি', unit: 'piece', priceRange: [200, 800], hasVariants: false },
    { name: 'Quran Bengali Translation', nameBn: 'কুরআন বাংলা অনুবাদ', unit: 'piece', priceRange: [250, 600], hasVariants: false },
    { name: 'Islamic Book', nameBn: 'ইসলামিক বই', unit: 'piece', priceRange: [80, 300], hasVariants: false },
    { name: 'A4 Paper Ream 500', nameBn: 'A4 কাগজ ৫০০ শিট', unit: 'pack', priceRange: [350, 550], hasVariants: false },
    { name: 'Stapler', nameBn: 'স্ট্যাপলার', unit: 'piece', priceRange: [50, 200], hasVariants: false },
    { name: 'Scotch Tape', nameBn: 'স্কচ টেপ', unit: 'piece', priceRange: [15, 40], hasVariants: false },
  ],
};

// ─── Main seed function ───────────────────────────────────────
async function seedProducts() {
  console.log('🌱 Connecting to database...');
  await mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  console.log('✅ Connected to MongoDB');

  try {
    // 1. Find user by phone
    const user = await User.findOne({ phone: { $regex: OWNER_PHONE } });
    if (!user) {
      console.error(`❌ No user found with phone: ${OWNER_PHONE}`);
      process.exit(1);
    }
    console.log(`👤 Found user: ${user.name} (${user.phone})`);

    // 2. Find shop
    const shop = await Shop.findOne({ owner: user._id });
    if (!shop) {
      console.error(`❌ No shop found for user: ${user.name}`);
      process.exit(1);
    }
    console.log(`🏪 Shop: ${shop.name} (type: ${shop.type})`);

    // 3. Get/create categories
    let categories = await Category.find({
      $or: [{ shop: shop._id }, { shop: null }],
      isActive: true,
    }).lean();

    if (categories.length === 0) {
      console.log('📂 No categories found. Seeding categories...');
      await seedCategories(shop._id, shop.type);
      categories = await Category.find({
        $or: [{ shop: shop._id }, { shop: null }],
        isActive: true,
      }).lean();
    }

    const parentCategories = categories.filter(c => !c.parent);
    const subcategories = categories.filter(c => c.parent);
    console.log(`📂 Categories: ${parentCategories.length} parents, ${subcategories.length} subcategories`);

    // 4. Check existing products
    const existingCount = await Product.countDocuments({ shop: shop._id });
    if (existingCount > 0) {
      console.log(`⚠️  Shop already has ${existingCount} products.`);
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => {
        rl.question('   Delete existing products and reseed? (y/N): ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() === 'y') {
        await Product.deleteMany({ shop: shop._id });
        console.log('🗑️  Deleted existing products.');
      } else {
        console.log('👋 Aborting seed.');
        process.exit(0);
      }
    }

    // 5. Select product pool
    const pool = PRODUCT_POOLS[shop.type] || PRODUCT_POOLS._default;
    const brands = pool.brands || PRODUCT_POOLS._default.brands;
    const templateProducts = pool.products;

    // Default colors/sizes for variant products (shop-type-specific or generic)
    const defaultSizes = pool.sizes || ['S', 'M', 'L', 'XL'];
    const defaultColors = pool.colors || ['Black', 'White', 'Red', 'Blue', 'Green', 'Grey'];

    // 6. Generate 1000 products
    console.log(`\n🏭 Generating ${TOTAL_PRODUCTS} products...`);
    const products = [];
    let codeCounter = 1;

    for (let i = 0; i < TOTAL_PRODUCTS; i++) {
      // Pick a random template product
      const template = templateProducts[i % templateProducts.length];
      const suffix = Math.floor(i / templateProducts.length);

      // Product code
      const code = `P${String(codeCounter++).padStart(4, '0')}`;

      // Pick category
      const parentCat = parentCategories.length > 0
        ? parentCategories[i % parentCategories.length]
        : null;
      const matchingSubs = parentCat
        ? subcategories.filter(s => String(s.parent) === String(parentCat._id))
        : [];
      const subCat = matchingSubs.length > 0
        ? matchingSubs[i % matchingSubs.length]
        : null;

      // Decide variant or not
      const shouldHaveVariants = template.hasVariants && (i % 3 !== 2); // ~66% of variant-capable products get variants

      // Brand (70% chance)
      const brand = Math.random() < 0.7 ? pick(brands) : undefined;

      // Product name with suffix for uniqueness
      const nameEn = suffix > 0 ? `${template.name} V${suffix + 1}` : template.name;
      const nameBn = suffix > 0 ? `${template.nameBn} V${suffix + 1}` : template.nameBn;

      // Barcode (40% chance for non-variant)
      const barcode = (!shouldHaveVariants && Math.random() < 0.4) ? genBarcode() : undefined;

      // Price
      const [minPrice, maxPrice] = template.priceRange;
      const sellingPrice = roundTo5(rand(minPrice, maxPrice));
      const marginPct = rand(8, 40); // 8-40% margin
      const buyingPrice = roundTo5(sellingPrice * (1 - marginPct / 100));

      // Stock: varied distribution
      let stock;
      const stockRoll = Math.random();
      if (stockRoll < 0.05) stock = 0;          // 5% out of stock
      else if (stockRoll < 0.15) stock = rand(1, 4);   // 10% very low stock
      else if (stockRoll < 0.30) stock = rand(5, 10);  // 15% low stock
      else if (stockRoll < 0.70) stock = rand(11, 100); // 40% normal
      else stock = rand(100, 500);                       // 30% high stock

      // MinStock
      const minStock = pick([3, 5, 5, 5, 10, 10, 15, 20]);

      // Tags (30% chance)
      const tags = [];
      if (Math.random() < 0.3) {
        const possibleTags = ['popular', 'new', 'bestseller', 'featured', 'sale', 'seasonal', 'premium', 'budget'];
        tags.push(...pickN(possibleTags, rand(1, 3)));
      }

      // Description (20% chance)
      const description = Math.random() < 0.2
        ? `${nameBn} - ${brand || 'ভালো মানের'} পণ্য। দোকান থেকে সরাসরি কিনুন।`
        : undefined;

      // Active (95% active)
      const isActive = Math.random() < 0.95;

      // totalSold (simulate some sales history)
      const totalSold = rand(0, 200);
      const lastSold = totalSold > 0 ? new Date(Date.now() - rand(0, 90) * 86400000) : undefined;

      if (shouldHaveVariants) {
        // Build variants
        const variantType = template.variantType || 'size';
        const variants = [];
        let variantIdx = 0;

        if (variantType === 'size+color') {
          const sizes = pickN(defaultSizes, rand(2, 5));
          const colors = pickN(defaultColors, rand(2, 4));
          for (const size of sizes) {
            for (const color of colors) {
              const vSelling = roundTo5(sellingPrice + rand(-50, 50));
              const vBuying = roundTo5(vSelling * (1 - marginPct / 100));
              const vStock = rand(0, 30);
              variants.push({
                sku: genSku(code, ++variantIdx),
                attributes: { size, color },
                buyingPrice: Math.max(5, vBuying),
                sellingPrice: Math.max(10, vSelling),
                stock: vStock,
                barcode: Math.random() < 0.3 ? genBarcode() : undefined,
                isActive: Math.random() < 0.92,
              });
            }
          }
        } else if (variantType === 'size') {
          const sizes = pickN(defaultSizes, rand(3, 6));
          for (const size of sizes) {
            const vSelling = roundTo5(sellingPrice + rand(-30, 30));
            const vBuying = roundTo5(vSelling * (1 - marginPct / 100));
            variants.push({
              sku: genSku(code, ++variantIdx),
              attributes: { size },
              buyingPrice: Math.max(5, vBuying),
              sellingPrice: Math.max(10, vSelling),
              stock: rand(0, 40),
              barcode: Math.random() < 0.3 ? genBarcode() : undefined,
              isActive: Math.random() < 0.95,
            });
          }
        } else if (variantType === 'color') {
          const colors = pickN(defaultColors, rand(3, 6));
          for (const color of colors) {
            const vSelling = roundTo5(sellingPrice);
            const vBuying = roundTo5(vSelling * (1 - marginPct / 100));
            variants.push({
              sku: genSku(code, ++variantIdx),
              attributes: { color },
              buyingPrice: Math.max(5, vBuying),
              sellingPrice: Math.max(10, vSelling),
              stock: rand(0, 35),
              barcode: Math.random() < 0.3 ? genBarcode() : undefined,
              isActive: Math.random() < 0.95,
            });
          }
        }

        products.push({
          shop: shop._id,
          code,
          name: nameEn,
          nameBn,
          category: parentCat?._id,
          subcategory: subCat?._id,
          brand,
          unit: template.unit,
          hasVariants: true,
          variants,
          minStock,
          tags,
          description,
          isActive,
          totalSold,
          lastSold,
          createdBy: user._id,
        });
      } else {
        // Simple product
        products.push({
          shop: shop._id,
          code,
          barcode,
          name: nameEn,
          nameBn,
          category: parentCat?._id,
          subcategory: subCat?._id,
          brand,
          unit: template.unit,
          hasVariants: false,
          buyingPrice: Math.max(1, buyingPrice),
          sellingPrice: Math.max(2, sellingPrice),
          stock,
          minStock,
          tags,
          description,
          isActive,
          totalSold,
          lastSold,
          createdBy: user._id,
        });
      }

      // Progress indicator
      if ((i + 1) % 200 === 0) {
        console.log(`   ... ${i + 1}/${TOTAL_PRODUCTS} products prepared`);
      }
    }

    // 7. Insert in batches (avoid memory issues)
    const BATCH_SIZE = 100;
    let inserted = 0;
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      await Product.insertMany(batch, { ordered: false });
      inserted += batch.length;
      console.log(`   ✅ Inserted ${inserted}/${TOTAL_PRODUCTS}`);
    }

    // 8. Update shop stats
    await Shop.findByIdAndUpdate(shop._id, {
      'stats.totalProducts': inserted,
    });

    // 9. Summary
    const variantCount = products.filter(p => p.hasVariants).length;
    const simpleCount = products.filter(p => !p.hasVariants).length;
    const inactiveCount = products.filter(p => !p.isActive).length;
    const withBarcode = products.filter(p => p.barcode).length;
    const totalVariants = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);

    console.log(`
╔═══════════════════════════════════════════════╗
║          🌱 Seed Complete!                    ║
╠═══════════════════════════════════════════════╣
║  Total Products:   ${String(inserted).padStart(6)}                    ║
║  Simple Products:  ${String(simpleCount).padStart(6)}                    ║
║  Variant Products: ${String(variantCount).padStart(6)}  (${totalVariants} total SKUs)     ║
║  With Barcode:     ${String(withBarcode).padStart(6)}                    ║
║  Inactive:         ${String(inactiveCount).padStart(6)}                    ║
║  Shop: ${shop.name.padEnd(38)}║
╚═══════════════════════════════════════════════╝
    `);
  } catch (error) {
    console.error('❌ Seed failed:', error.message);
    if (error.writeErrors) {
      console.error(`   ${error.writeErrors.length} write errors (possibly duplicate codes)`);
    }
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed.');
  }
}

// Run
seedProducts().catch(err => {
  console.error(err);
  process.exit(1);
});
