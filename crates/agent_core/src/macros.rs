//! Derive sets shared by every wire type. `wire_types!` is for structs and tagged enums,
//! `wire_enums!` for plain string unions (adds `Copy`/`Eq`/`Hash`/`Ord` so they can be map keys).

macro_rules! wire_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

macro_rules! wire_enums {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            #[serde(rename_all = "camelCase")]
            $item
        )*
    };
}
