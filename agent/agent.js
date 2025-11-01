import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// ===================================================================
// CONFIG
// ===================================================================
// Lokal geliştirirken env vermezsen localhost'u kullanır.
// Render'da ise ortam değişkeni olarak MARKET_BASE'i vereceğiz.
const MARKET_BASE =
  process.env.MARKET_BASE || "https://agentic-commerce-poc.onrender.com";

// PoC: tek kullanıcı sepet durumu (memory)
let CURRENT_CART = null;

// ===================================================================
// STATIC: .well-known (ai-plugin.json) SERVE
// ===================================================================
app.use("/.well-known", express.static(path.join(__dirname, ".well-known")));

// OpenAPI dosyasını da buradan verelim
app.get("/openapi.yaml", (req, res) => {
  const filePath = path.join(__dirname, "openapi.yaml");
  try {
    const content = fs.readFileSync(filePath, "utf8");
    res.setHeader("Content-Type", "text/yaml");
    res.send(content);
  } catch (e) {
    res.status(404).json({ error: "openapi.yaml not found" });
  }
});

// Basit health
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "agent", market_base: MARKET_BASE });
});

// GET ile girince info dönsün (tarayıcıdan test için)
app.get("/agent/message", (req, res) => {
  res.json({
    info: "Bu endpoint POST ile kullanılmalı.",
    example: {
      method: "POST",
      url: `${req.protocol}://${req.get("host")}/agent/message`,
      body: { message: "süt ürünleri ekle" }
    }
  });
});

// ===================================================================
// YARDIMCI FONKSİYONLAR
// ===================================================================
function detectIntent(text) {
  const t = text.toLowerCase();
  if (t.includes("öde") || t.includes("satın al") || t.includes("tamamla")) {
    return "checkout";
  }
  return "search_and_add";
}

function extractQuery(text) {
  const t = text.toLowerCase();
  if (t.includes("peynir")) return "peynir";
  if (t.includes("tereyağı") || t.includes("tereyagi")) return "tereyağı";
  // default kategori
  return "sut";
}

// ===================================================================
// ANA ENDPOINT
// ===================================================================
app.post("/agent/message", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  const intent = detectIntent(message);

  try {
    // ---------------------------------------------------------------
    // 1) CHECKOUT AKIŞI
    // ---------------------------------------------------------------
    if (intent === "checkout") {
      if (!CURRENT_CART) {
        return res.json({
          reply: "Sepet yok görünüyor. Önce ürün seçelim mi?"
        });
      }

      const checkoutResp = await axios.post(`${MARKET_BASE}/acp/checkout`, {
        cart_id: CURRENT_CART,
        buyer: { name: "Atınç Akçayöz" },
        payment_method: { type: "delegated", token: "pm_demo" }
      });

      const d = checkoutResp.data;
      // sepeti sıfırla
      CURRENT_CART = null;

      return res.json({
        reply: `Ödeme alındı ✅ Toplam: ${d.total} ${d.currency}. Market kârı: ${d.total_profit} ${d.currency}. Sipariş no: ${d.order_id}`
      });
    }

    // ---------------------------------------------------------------
    // 2) ÜRÜN ARAMA + SEPETE EKLEME AKIŞI
    // ---------------------------------------------------------------

    // 2.a: bağlı merchant'ları al
    const merchantsResp = await axios.get(`${MARKET_BASE}/acp/merchants`);
    const merchants = merchantsResp.data.items || [];

    if (!merchants.length) {
      return res.json({
        reply: "Şu anda bağlı market yok gibi görünüyor."
      });
    }

    // 2.b: en kârlı marketi seç (profit_weight'e göre)
    const chosenMerchant = merchants
      .slice()
      .sort((a, b) => (b.profit_weight || 0) - (a.profit_weight || 0))[0];

    // 2.c: kullanıcı cümlesinden arama sorgusunu çıkar
    const q = extractQuery(message);

    // 2.d: seçilen marketin ürünlerini al
    const productsResp = await axios.get(`${MARKET_BASE}/acp/products`, {
      params: {
        q,
        limit: 10,
        merchant_id: chosenMerchant.id
      }
    });

    const products = productsResp.data.items || [];

    if (!products.length) {
      return res.json({
        reply: `“${chosenMerchant.name}” içinde “${q}” için ürün bulamadım. Başka ürün ya da market deneyelim mi?`
      });
    }

    // 2.e: sepet yoksa oluştur
    if (!CURRENT_CART) {
      const cartResp = await axios.post(`${MARKET_BASE}/acp/cart`);
      CURRENT_CART = cartResp.data.id;
    }

    // 2.f: en ucuz 2 ürünü ekle (seçilen marketten)
    const sorted = products
      .map((p) => ({
        ...p,
        priceValue: p.price ?? p.price?.value ?? 0
      }))
      .sort((a, b) => a.priceValue - b.priceValue)
      .slice(0, 2);

    for (const p of sorted) {
      await axios.post(
        `${MARKET_BASE}/acp/cart/${CURRENT_CART}/items`,
        {
          product_id: p.id,
          quantity: 1
        }
      );
    }

    return res.json({
      reply: `${chosenMerchant.name} içinden ${sorted.length} ürünü sepete ekledim. “öde” dersen siparişi tamamlarım.`,
      cart_id: CURRENT_CART,
      merchant: {
        id: chosenMerchant.id,
        name: chosenMerchant.name
      },
      products: sorted.map((p) => ({
        id: p.id,
        title: p.title,
        price: p.price,
        profit: p.profit,
        image_url: p.image_url
      }))
    });
  } catch (err) {
    console.error("Agent error:", err.message);
    return res.status(500).json({
      error: err.message,
      hint: "MARKET_BASE doğru mu? Market servisi erişilebilir mi?"
    });
  }
});

// ===================================================================
// SERVER START
// ===================================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent (multi-merchant) running on http://0.0.0.0:${PORT}`);
});
