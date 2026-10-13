//! Russell's FS-1 rulings, recorded as constants.
//!
//! R-1: consensus accepts every input count from 1 through 8. The wallet, when it
//! holds enough of its own real notes, pads to 2, 4, or 8. Padding never invents
//! a dummy input. A normal send prefers the 2-input shape.
//!
//! R-2: verify weight is 25 + 25 weight units per input. The 16-send reserve is
//! 2,336 weight units.

/// Smallest input count consensus accepts.
pub const INPUT_MIN: usize = 1;
/// Largest input count consensus accepts.
pub const INPUT_MAX: usize = 8;

/// Fixed term of `W_FS1`.
pub const W_FS1_BASE: u64 = 25;
/// Per-input term of `W_FS1`.
pub const W_FS1_PER_INPUT: u64 = 25;
/// Output weight used by the reserve formula.
pub const W_OUT: u64 = 23;
/// Transaction weight used by the reserve formula.
pub const W_TX: u64 = 2;
/// Sends covered by the reserve.
pub const RESERVE_SENDS: u64 = 16;

/// Preferred input count for a normal send.
pub const PREFERRED_INPUTS: usize = 2;

/// 16 × (W_FS1(2) + 3 × W_OUT + W_TX) = 16 × (75 + 69 + 2).
pub const RESERVE_WU: u64 = 2_336;

/// Consensus accepts this input count.
pub fn consensus_accepts(inputs: usize) -> bool {
  (INPUT_MIN ..= INPUT_MAX).contains(&inputs)
}

/// `W_FS1(n) = 25 + 25n` for an accepted input count.
pub fn verify_weight(inputs: usize) -> Option<u64> {
  if !consensus_accepts(inputs) {
    return None;
  }
  Some(W_FS1_BASE + W_FS1_PER_INPUT * inputs as u64)
}

/// The 16-send reserve. It is the constant 2,336, recomputed from the terms.
pub fn reserve_wu() -> u64 {
  let two = verify_weight(PREFERRED_INPUTS).expect("2 inputs are accepted");
  RESERVE_SENDS * (two + 3 * W_OUT + W_TX)
}

/// Wallet default shape.
///
/// `spend` is how many real notes the payment needs. `held` is how many real
/// notes the wallet can add, including those `spend` notes. When `held` reaches
/// the next of 2, 4, or 8, the result is that count. Otherwise the result stays
/// `spend`. A count outside 1..=8 is rejected. No dummy input is represented.
pub fn wallet_pad(spend: usize, held: usize) -> Option<usize> {
  if !consensus_accepts(spend) || held < spend {
    return None;
  }
  let target = if spend <= 2 {
    2
  } else if spend <= 4 {
    4
  } else {
    8
  };
  if held >= target {
    Some(target)
  } else {
    Some(spend)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn r1_accepts_every_count_through_eight() {
    for n in 0 .. 12 {
      assert_eq!(consensus_accepts(n), (1 ..= 8).contains(&n), "{n}");
    }
  }

  #[test]
  fn r1_pads_with_real_notes_only() {
    assert_eq!(wallet_pad(1, 1), Some(1));
    assert_eq!(wallet_pad(1, 2), Some(2));
    assert_eq!(wallet_pad(2, 8), Some(2));
    assert_eq!(wallet_pad(3, 3), Some(3));
    assert_eq!(wallet_pad(3, 4), Some(4));
    assert_eq!(wallet_pad(4, 7), Some(4));
    assert_eq!(wallet_pad(5, 7), Some(5));
    assert_eq!(wallet_pad(5, 8), Some(8));
    assert_eq!(wallet_pad(6, 8), Some(8));
    assert_eq!(wallet_pad(7, 8), Some(8));
    assert_eq!(wallet_pad(8, 8), Some(8));
    assert_eq!(wallet_pad(0, 4), None);
    assert_eq!(wallet_pad(9, 9), None);
    assert_eq!(wallet_pad(3, 2), None);
    assert_eq!(PREFERRED_INPUTS, 2);
  }

  #[test]
  fn r2_weight_and_reserve() {
    assert_eq!(verify_weight(1), Some(50));
    assert_eq!(verify_weight(2), Some(75));
    assert_eq!(verify_weight(3), Some(100));
    assert_eq!(verify_weight(4), Some(125));
    assert_eq!(verify_weight(8), Some(225));
    assert_eq!(verify_weight(0), None);
    assert_eq!(verify_weight(9), None);
    assert_eq!(reserve_wu(), 2_336);
    assert_eq!(reserve_wu(), RESERVE_WU);
    assert_eq!(RESERVE_SENDS * (75 + 3 * W_OUT + W_TX), RESERVE_WU);
  }
}
