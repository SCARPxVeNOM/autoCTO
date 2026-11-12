use crate::types::{BPS, RATE_SCALE};
use near_sdk::env;

pub use u256::U256;

// Kept in its own module so the lint below covers only the uint crate's generated code.
#[allow(clippy::manual_div_ceil)]
mod u256 {
    uint::construct_uint! {
        pub struct U256(4);
    }
}

/// a * b / c, rounded down, with a 256-bit intermediate.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if c == 0 {
        env::panic_str("division by zero");
    }
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    if r > U256::from(u128::MAX) {
        env::panic_str("overflow");
    }
    r.as_u128()
}

/// Constant-product output: how much of `reserve_out` you get for `amount_in`.
pub fn amm_out(reserve_in: u128, reserve_out: u128, amount_in: u128) -> u128 {
    mul_div(reserve_out, amount_in, reserve_in + amount_in)
}

/// Fair exchange rate (target tokens -> buyer tokens, scaled by RATE_SCALE)
/// from both curves' spot prices: price_t / price_b.
pub fn fair_rate_ppm(t_near: u128, t_tokens: u128, b_near: u128, b_tokens: u128) -> u128 {
    // (t_near / t_tokens) / (b_near / b_tokens) = t_near * b_tokens / (t_tokens * b_near)
    let num = U256::from(t_near) * U256::from(b_tokens) * U256::from(RATE_SCALE);
    let den = U256::from(t_tokens) * U256::from(b_near);
    if den.is_zero() {
        env::panic_str("empty curve");
    }
    let r = num / den;
    if r > U256::from(u128::MAX) {
        env::panic_str("overflow");
    }
    r.as_u128()
}

/// Premium of `rate` over `fair`, in basis points (negative = discount).
pub fn premium_bps(rate: u128, fair: u128) -> i64 {
    if fair == 0 {
        return i64::MAX;
    }
    let scaled = mul_div(rate, BPS, fair) as i128;
    (scaled - BPS as i128).clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

pub fn bps_of(amount: u128, bps: u32) -> u128 {
    mul_div(amount, bps as u128, BPS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fair_rate_equal_curves_is_one() {
        let n = 30 * 10u128.pow(24);
        let t = 10u128.pow(27);
        assert_eq!(fair_rate_ppm(n, t, n, t), RATE_SCALE);
    }

    #[test]
    fn fair_rate_cheaper_target() {
        let n = 30 * 10u128.pow(24);
        let t = 10u128.pow(27);
        // target price is half the buyer's
        assert_eq!(fair_rate_ppm(n, 2 * t, n, t), RATE_SCALE / 2);
    }

    #[test]
    fn premium_math() {
        assert_eq!(premium_bps(1_200_000, 1_000_000), 2000);
        assert_eq!(premium_bps(500_000, 1_000_000), -5000);
        assert_eq!(premium_bps(1_000_000, 1_000_000), 0);
    }

    #[test]
    fn amm_out_never_drains() {
        let out = amm_out(100, 1_000, u128::MAX / 2);
        assert!(out < 1_000);
    }
}
