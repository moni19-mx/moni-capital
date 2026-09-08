// lib/smartImportSchema.js
// Schema de extraccion de Smart Import -- puros datos, sin I/O, para poder
// probarlo directamente sin necesitar @supabase/supabase-js ni env vars.
// Importado por api/smart-import.js (el endpoint real) y por los tests.

export const SmartImportRawExtractionSchema = {
  definitions: {
    FieldValueString: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { type: ["string", "null"] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueNumber: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { type: ["number", "null"] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueTradeType: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["BUY", "SELL", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueStatusGuess: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["PROPOSED", "PENDING", "EXECUTED", "CANCELLED", "REJECTED", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueSide: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["LONG", "SHORT", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueMarginMode: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["ISOLATED", "CROSS", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueQuantity: { type: "object", additionalProperties: false, required: ["value", "unit", "confidence", "evidence_text"],
      properties: { value: { type: ["number", "null"] }, unit: { type: ["string", "null"] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
  },
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["document_type", "sensitive_content_detected", "source", "transaction", "warnings"],
      properties: {
        document_type: { enum: ["PURCHASE_CONFIRMATION", "SALE_CONFIRMATION"] },
        sensitive_content_detected: { type: "boolean" },
        source: {
          type: "object", additionalProperties: false, required: ["provider", "account_name"],
          properties: {
            provider: { $ref: "#/definitions/FieldValueString" },
            account_name: { $ref: "#/definitions/FieldValueString" },
          },
        },
        transaction: {
          type: "object", additionalProperties: false,
          required: ["ticker", "asset_name", "type", "status_text_raw", "status_model_guess", "quantity", "price", "total", "currency", "fee", "transaction_date", "transaction_time", "provider_transaction_id", "order_id"],
          properties: {
            ticker: { $ref: "#/definitions/FieldValueString" },
            asset_name: { $ref: "#/definitions/FieldValueString" },
            type: { $ref: "#/definitions/FieldValueTradeType" },
            status_text_raw: { $ref: "#/definitions/FieldValueString" },
            status_model_guess: { $ref: "#/definitions/FieldValueStatusGuess" },
            quantity: { $ref: "#/definitions/FieldValueNumber" },
            price: { $ref: "#/definitions/FieldValueNumber" },
            total: { $ref: "#/definitions/FieldValueNumber" },
            currency: { $ref: "#/definitions/FieldValueString" },
            fee: { $ref: "#/definitions/FieldValueNumber" },
            transaction_date: { $ref: "#/definitions/FieldValueString" },
            transaction_time: { $ref: "#/definitions/FieldValueString" },
            provider_transaction_id: { $ref: "#/definitions/FieldValueString" },
            order_id: { $ref: "#/definitions/FieldValueString" },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: ["document_type", "sensitive_content_detected", "account", "observed_at", "balances", "warnings"],
      properties: {
        document_type: { enum: ["SPOT_ACCOUNT_SNAPSHOT"] },
        sensitive_content_detected: { type: "boolean" },
        account: {
          type: "object", additionalProperties: false, required: ["provider", "account_type"],
          properties: { provider: { $ref: "#/definitions/FieldValueString" }, account_type: { $ref: "#/definitions/FieldValueString" } },
        },
        observed_at: { $ref: "#/definitions/FieldValueString" },
        balances: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["asset_symbol", "quantity"],
            properties: { asset_symbol: { $ref: "#/definitions/FieldValueString" }, quantity: { $ref: "#/definitions/FieldValueNumber" } },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: ["document_type", "sensitive_content_detected", "account", "observed_at", "balances", "warnings"],
      properties: {
        document_type: { enum: ["FUTURES_ACCOUNT_SNAPSHOT"] },
        sensitive_content_detected: { type: "boolean" },
        account: {
          type: "object", additionalProperties: false, required: ["provider", "account_type", "product_type"],
          properties: {
            provider: { $ref: "#/definitions/FieldValueString" },
            account_type: { $ref: "#/definitions/FieldValueString" },
            product_type: { $ref: "#/definitions/FieldValueString" },
          },
        },
        observed_at: { $ref: "#/definitions/FieldValueString" },
        balances: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["asset_symbol", "wallet_balance", "margin_balance", "available_balance", "unrealized_pnl", "initial_margin", "maintenance_margin"],
            properties: {
              asset_symbol: { $ref: "#/definitions/FieldValueString" },
              wallet_balance: { $ref: "#/definitions/FieldValueNumber" },
              margin_balance: { $ref: "#/definitions/FieldValueNumber" },
              available_balance: { $ref: "#/definitions/FieldValueNumber" },
              unrealized_pnl: { $ref: "#/definitions/FieldValueNumber" },
              initial_margin: { $ref: "#/definitions/FieldValueNumber" },
              maintenance_margin: { $ref: "#/definitions/FieldValueNumber" },
            },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: [
        "document_type", "sensitive_content_detected", "account_ref", "instrument", "side", "leverage",
        "margin_mode", "provider_position_id", "position_quantity", "margin_used", "entry_price",
        "mark_price", "liquidation_price", "price_currency", "unrealized_pnl", "roi_pct", "notional",
        "obtained_pnl_raw", "warnings",
      ],
      properties: {
        document_type: { enum: ["FUTURES_POSITION_SNAPSHOT"] },
        sensitive_content_detected: { type: "boolean" },
        account_ref: { $ref: "#/definitions/FieldValueString" },
        instrument: { $ref: "#/definitions/FieldValueString" },
        side: { $ref: "#/definitions/FieldValueSide" },
        leverage: { $ref: "#/definitions/FieldValueNumber" },
        margin_mode: { $ref: "#/definitions/FieldValueMarginMode" },
        provider_position_id: { $ref: "#/definitions/FieldValueString" },
        position_quantity: { $ref: "#/definitions/FieldValueQuantity" },
        margin_used: { $ref: "#/definitions/FieldValueNumber" },
        entry_price: { $ref: "#/definitions/FieldValueNumber" },
        mark_price: { $ref: "#/definitions/FieldValueNumber" },
        liquidation_price: { $ref: "#/definitions/FieldValueNumber" },
        price_currency: { $ref: "#/definitions/FieldValueString" },
        unrealized_pnl: { $ref: "#/definitions/FieldValueNumber" },
        roi_pct: { $ref: "#/definitions/FieldValueNumber" },
        notional: { $ref: "#/definitions/FieldValueNumber" },
        // obtained_pnl_raw: campo separado de unrealized_pnl -- ej. "PNL
        // Obtenido" que Binance muestra en algunas posiciones. Se
        // preserva RAW, nunca se mapea a realized_pnl_value (decision ya
        // aprobada -- semantica no confirmada todavia).
        obtained_pnl_raw: {
          type: "object", additionalProperties: false, required: ["value", "asset_symbol", "confidence", "evidence_text"],
          properties: {
            value: { type: ["number", "null"] },
            asset_symbol: { type: ["string", "null"] },
            confidence: { enum: ["HIGH", "MEDIUM", "LOW"] },
            evidence_text: { type: ["string", "null"] },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: ["document_type", "sensitive_content_detected", "warnings"],
      properties: {
        document_type: { enum: ["UNKNOWN"] },
        sensitive_content_detected: { type: "boolean" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
  ],
};
