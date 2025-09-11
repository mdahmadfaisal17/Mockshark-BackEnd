// src/controllers/paddle/paddle.js
import prisma from "../../utils/prismaClient.js";

const PADDLE_BASE_URL = process.env.PADDLE_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

async function createProductInPaddle(name, description) {
  const response = await fetch(`${PADDLE_BASE_URL}/products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
    },
    body: JSON.stringify({
      name,
      description,
      tax_category: "standard",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Failed to create product in Paddle");
  }
  return data.data;
}

export const createPaddleProduct = async (req, res) => {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, message: "Method not allowed" });
  }

  const { name, description } = req.body;

  try {
    const newPaddleProduct = await createProductInPaddle(name, description);
    return res.status(200).json({
      success: true,
      productId: newPaddleProduct.id,
    });
  } catch (error) {
    console.error("Paddle Product API Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createPaddlePrice = async (req, res) => {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, message: "Method not allowed" });
  }

  let { productId, description, attributes, currency, type } = req.body;

  const PADDLE_BASE = PADDLE_BASE_URL;
  const AUTH_HEADER = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
    Accept: "application/json",
  };

  const toCents = (v) => {
    return Math.round(Number(v) * 100);
  };

  const fetchJson = async (url, init) => {
    const resp = await fetch(url, init);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        `Paddle request failed (${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  try {
     try {
      await fetchJson(`${PADDLE_BASE}/products/${productId}`, {
        method: "GET",
        headers: AUTH_HEADER,
      });
    } catch (error) {
      if (error.status === 404) { // Product not found in Paddle
        const localProduct = await prisma.product.findFirst({
          where: { paddleProductId: productId },
        });

        if (localProduct) {
          const newPaddleProduct = await createProductInPaddle(
            localProduct.name,
            localProduct.longDescription || localProduct.shortDescription || localProduct.name
          );

          await prisma.product.update({
            where: { id: localProduct.id },
            data: { paddleProductId: newPaddleProduct.id },
          });

          productId = newPaddleProduct.id;
        } else {
          return res.status(400).json({ success: false, message: `Product with paddleProductId ${productId} not found.` });
        }
      } else {
        throw error;
      }
    }

    const getPriceById = async (priceId) => {
      return fetchJson(`${PADDLE_BASE}/prices/${priceId}`, {
        method: "GET",
        headers: AUTH_HEADER,
      });
    };

    const listPricesByProduct = async (prodId, cursor = null, acc = []) => {
      const q = new URLSearchParams({ product_id: prodId });
      if (cursor) q.set("after", cursor);
      const data = await fetchJson(`${PADDLE_BASE}/prices?${q.toString()}`, {
        method: "GET",
        headers: AUTH_HEADER,
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      const next = data?.meta?.pagination?.has_more
        ? data?.meta?.pagination?.end_cursor
        : null;
      const merged = acc.concat(items);
      return next ? listPricesByProduct(prodId, next, merged) : merged;
    };

    const amountsMatch = (paddlePrice, cents, curr) => {
      const unit = paddlePrice?.unit_price;
      return (
        String(unit?.amount) === String(cents) &&
        String(unit?.currency_code).toUpperCase() === String(curr).toUpperCase()
      );
    };

    const createPrice = async ({
      prodId,
      desc,
      cents,
      curr,
      attributeKey,
      attrId,
    }) => {
      const payload = {
        product_id: prodId,
        description: desc,
        unit_price: {
          amount: String(cents),
          currency_code: curr,
        },
        custom_data: {
          attributeKey,
          id: attrId,
        },
      };

      const created = await fetchJson(`${PADDLE_BASE}/prices`, {
        method: "POST",
        headers: AUTH_HEADER,
        body: JSON.stringify(payload),
      });

      return created?.data;
    };

    if (type !== 'bundle' && (!productId || !attributes || typeof attributes !== "object")) {
      return res.status(400).json({
        success: false,
        message:
          "Missing or invalid payload. Require: productId, attributes (object).",
      });
    }

    const updatedAttributes = { ...attributes };

    if (type === 'bundle') {
      const { price, paddlePriceId } = req.body;
      if (!price || !productId) {
        return res.status(400).json({
          success: false,
          message: "Missing price or productId for bundle.",
        });
      }

      const cents = toCents(price);
      let finalPriceId = null;

      if (paddlePriceId) {
        try {
          const existing = await getPriceById(paddlePriceId);
          const priceData = existing?.data;
          if (
            priceData?.product_id === productId &&
            amountsMatch(priceData, cents, currency)
          ) {
            finalPriceId = priceData.id;
          }
        } catch (e) {}
      }

      if (!finalPriceId) {
        try {
          const allPrices = await listPricesByProduct(productId);
          const found = allPrices.find((p) =>
            amountsMatch(p, cents, currency)
          );
          if (found) {
            finalPriceId = found.id;
          }
        } catch (e) {}
      }

      if (!finalPriceId) {
        const created = await createPrice({
          prodId: productId,
          desc: description,
          cents,
          curr: currency,
          attributeKey: "bundle",
          attrId: productId,
        });
        finalPriceId = created?.id;
        if (!finalPriceId) throw new Error("Failed to create new bundle price");
      }

      return res.status(200).json({
        success: true,
        paddlePriceId: finalPriceId,
      });

    } else {
      for (const [key, value] of Object.entries(attributes)) {
        const { costPrice, size, id: attributeId, paddlePriceId } = value || {};
        if (costPrice == null) {
          throw new Error(`Attribute "${key}" is missing costPrice`);
        }

        const cents = toCents(costPrice);
        const desc = `${description} - ${size ?? key}`;

        let finalPriceId = null;

        if (paddlePriceId) {
          try {
            const existing = await getPriceById(paddlePriceId);
            const price = existing?.data;
            if (
              price?.product_id === productId &&
              amountsMatch(price, cents, currency)
            ) {
              finalPriceId = price.id;
            } else {}
          } catch (e) {}
        }

        if (!finalPriceId) {
          try {
            const all = await listPricesByProduct(productId);
            const found = all.find((p) => {
              const cd = p?.custom_data || {};
              const sameCustom =
                String(cd.attributeKey) === String(key) &&
                String(cd.id) === String(attributeId);
              return sameCustom && amountsMatch(p, cents, currency);
            });
            if (found) {
              finalPriceId = found.id;
            }
          } catch (e) {}
        }

        if (!finalPriceId) {
          const created = await createPrice({
            prodId: productId,
            desc,
            cents,
            curr: currency,
            attributeKey: key,
            attrId: attributeId,
          });
          finalPriceId = created?.id;
          if (!finalPriceId) throw new Error("Failed to obtain new price id");
        }

        updatedAttributes[key] = {
          ...value,
          paddlePriceId: finalPriceId,
        };
      }
    }

    return res.status(200).json({
      success: true,
      attributes: updatedAttributes,
    });
  } catch (error) {
    console.error("Paddle Price API Error:", error);
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
  }
};

export const getPaddleProduct = async (req, res) => {
  if (req.method !== "GET") {
    return res
      .status(405)
      .json({ success: false, message: "Method not allowed" });
  }

  const { id } = req.params; // This is the old paddleProductId

  try {
    const response = await fetch(`${PADDLE_BASE_URL}/products/${id}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        const localProduct = await prisma.product.findFirst({
          where: { paddleProductId: id },
        });

        if (localProduct) {
          try {
            const newPaddleProduct = await createProductInPaddle(
              localProduct.name,
              localProduct.longDescription || localProduct.shortDescription || localProduct.name
            );

            await prisma.product.update({
              where: { id: localProduct.id },
              data: { paddleProductId: newPaddleProduct.id },
            });

            return res.status(200).json({
              success: true,
              product: newPaddleProduct,
            });
          } catch (creationError) {
            console.error("Paddle Product Creation Error:", creationError);
            return res.status(500).json({ success: false, message: creationError.message });
          }
        }
      }
      
      const data = await response.json();
      throw new Error(data.error?.message || "Failed to get product");
    }

    const data = await response.json();
    return res.status(200).json({
      success: true,
      product: data.data,
    });
  } catch (error) {
    console.error("Paddle Product API Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};