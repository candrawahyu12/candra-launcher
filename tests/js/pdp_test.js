const assert = require("assert");
const P = require("../../chrome_extension/pdp.js");
// ---- Shopee: 2 tingkat varian, harga & foto berbeda per varian (harga x100000)
const shopee = { error: null, data: { item: { item_id: 111, shop_id: 9, title: "Meja Nakas 2 Laci", description: "Bahan kayu.\nUkuran 40x30",
  images: ["aaa", "bbb"], price: 9000000000, stock: 50, historical_sold: 1200, item_rating: { rating_star: 4.86, rating_count: [547, 1, 2, 3, 4, 500] },
  categories: [{ display_name: "Perlengkapan Rumah" }, { display_name: "Furniture" }],
  tier_variations: [{ name: "Warna", options: ["Putih", "Hitam"], images: ["w1", "w2"] }, { name: "Ukuran", options: ["S", "L"], images: null }],
  models: [ { name: "Putih,S", price: 9000000000, stock: 5, extinfo: { tier_index: [0, 0] } }, { name: "Putih,L", price: 10500000000, stock: 0, extinfo: { tier_index: [0, 1] } },
            { name: "Hitam,S", price: 9500000000, stock: 7, extinfo: { tier_index: [1, 0] } }, { name: "Hitam,L", price: 12000000000, stock: 3, extinfo: { tier_index: [1, 1] } } ] },
  shop_detailed: { name: "Toko Furnitur" } } };
const r = P.parse(shopee, "shopee.co.id");
assert.strictEqual(r.variants.length, 4);
assert.deepStrictEqual(r.variants.map(v => v.price), [90000, 105000, 95000, 120000]);
assert.deepStrictEqual(r.variants[1].options, { Warna: "Putih", Ukuran: "L" });
assert.ok(r.variants[0].image.endsWith("/file/w1") && r.variants[3].image.endsWith("/file/w2"));
assert.strictEqual(r.variants[1].stock, 0);
assert.strictEqual(r.price, 90000); assert.strictEqual(r.itemId, "111");
assert.strictEqual(r.category, "Perlengkapan Rumah > Furniture"); assert.strictEqual(r.rating, 4.9); assert.strictEqual(r.review_count, 547);
assert.strictEqual(r.shop_name, "Toko Furnitur"); assert.ok(r.description.includes("Ukuran 40x30")); assert.strictEqual(r.images.length, 2);
// harga format polos (tanpa x100000) tetap benar
const plain = JSON.parse(JSON.stringify(shopee)); plain.data.item.models.forEach(m => m.price = m.price / 1e5); plain.data.item.price /= 1e5;
assert.deepStrictEqual(P.parse(plain, "shopee.co.id").variants.map(v => v.price), [90000, 105000, 95000, 120000]);
// ---- Tokopedia
const toped = { data: { pdpGetLayout: { basicInfo: { alias: "toko/meja", shopName: "Toko X" }, components: [
  { name: "product_content", data: [{ name: "Meja Nakas", price: { value: 100000 } }] },
  { name: "product_media", data: [{ media: [{ type: "image", URLOriginal: "https://images.tokopedia.net/a.jpg" }] }] },
  { name: "product_detail", data: [{ content: [{ title: "Deskripsi", subtitle: "Kayu kokoh" }] }] },
  { name: "product_variant", data: [{ variants: [{ name: "Warna", option: [{ productVariantOptionID: "1", value: "Putih", picture: { urlOriginal: "https://images.tokopedia.net/p.jpg" } }, { productVariantOptionID: "2", value: "Hitam" }] },
    { name: "Ukuran", option: [{ productVariantOptionID: "3", value: "S" }, { productVariantOptionID: "4", value: "L" }] }],
    children: [ { optionID: ["1", "3"], price: 100000, stock: { stock: 4 } }, { optionID: ["1", "4"], price: 130000, stock: { stock: 0 } }, { optionID: ["2", "3"], price: 110000, stock: { stock: 9 } } ] }] } ] } } };
const t = P.parse(toped, "www.tokopedia.com");
assert.deepStrictEqual(t.variants.map(v => v.price), [100000, 130000, 110000]);
assert.deepStrictEqual(t.variants[2].options, { Warna: "Hitam", Ukuran: "S" });
assert.strictEqual(t.variants[0].image, "https://images.tokopedia.net/p.jpg"); assert.strictEqual(t.description, "Kayu kokoh"); assert.strictEqual(t.price, 100000);
// sampah -> null
assert.strictEqual(P.parse({ a: 1 }, "shopee.co.id"), null); assert.strictEqual(P.parse("bukan json", "shopee.co.id"), null);
console.log("pdp ok");
