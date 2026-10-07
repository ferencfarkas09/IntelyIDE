//! Usage and cost normalisation (providers-plan 4.5). An unknown model is `unknown`, never zero.

wire_enums! {
    pub enum CostBasis {
        Billed,
        Estimated,
        Subscription,
        Included,
        Unknown,
    }
}

wire_types! {
    #[serde(rename_all = "camelCase")]
    pub struct TokenCounts {
        pub input_tokens: u32,
        pub output_tokens: u32,
        pub cache_read: u32,
        pub cache_write: u32,
        pub reasoning_tokens: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub cost_usd: Option<f64>,
    }

    /// Cumulative tokens of one model (a run with delegates uses several; the provider reports cost per model, not per role).
    #[serde(rename_all = "camelCase")]
    pub struct ModelTokens {
        pub model: String,
        pub tokens: TokenCounts,
    }

    #[serde(rename_all = "camelCase")]
    pub struct UsageRecord {
        pub model: String,
        pub cost_basis: CostBasis,
        /// Usage of the turn that just ended.
        pub per_turn: TokenCounts,
        /// Usage of the whole run so far.
        pub cumulative: TokenCounts,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub premium_requests: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub context_used: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub context_size: Option<u32>,
        /// Cumulative per model, from the provider's per-model usage (Claude `modelUsage`). Empty = not reported.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub per_model: Vec<ModelTokens>,
    }
}
