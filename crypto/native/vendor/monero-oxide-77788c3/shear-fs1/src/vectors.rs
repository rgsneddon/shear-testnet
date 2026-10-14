//! Hex helpers, and readers for the shared vector files under `vectors/`.

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
  const DIGITS: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for b in bytes {
    out.push(char::from(DIGITS[usize::from(b >> 4)]));
    out.push(char::from(DIGITS[usize::from(b & 15)]));
  }
  out
}

/// Parse hex. `None` on odd length or a non-hex digit.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
  let text = text.as_bytes();
  if text.len() % 2 != 0 {
    return None;
  }
  let digit = |c: u8| match c {
    b'0' ..= b'9' => Some(c - b'0'),
    b'a' ..= b'f' => Some(c - b'a' + 10),
    b'A' ..= b'F' => Some(c - b'A' + 10),
    _ => None,
  };
  text.chunks_exact(2).map(|pair| Some((digit(pair[0])? << 4) | digit(pair[1])?)).collect()
}

/// Parse exactly `N` bytes of hex.
pub fn unhex_n<const N: usize>(text: &str) -> Option<[u8; N]> {
  unhex(text)?.try_into().ok()
}

#[cfg(test)]
pub(crate) fn unhex32(text: &str) -> [u8; 32] {
  unhex_n::<32>(text).expect("32 bytes of hex")
}

/// A tab-separated vector file. `#` starts a comment line.
#[cfg(test)]
pub(crate) struct Vectors {
  pub(crate) rows: Vec<Vec<String>>,
}

#[cfg(test)]
impl Vectors {
  fn parse(text: &str) -> Self {
    let rows = text
      .lines()
      .filter(|line| !line.is_empty() && !line.starts_with('#'))
      .map(|line| line.split('\t').map(str::to_string).collect())
      .collect();
    Self { rows }
  }

  pub(crate) fn generators() -> Self {
    Self::parse(include_str!("../vectors/generators.txt"))
  }

  pub(crate) fn tree_chain() -> Self {
    Self::parse(include_str!("../vectors/tree_chain.txt"))
  }

  /// The value of a two-column `key<TAB>value` row.
  pub(crate) fn get(&self, key: &str) -> &str {
    self
      .rows
      .iter()
      .find(|row| row.len() == 2 && row[0] == key)
      .map(|row| row[1].as_str())
      .unwrap_or_else(|| panic!("no {key} row"))
  }

  /// `note<TAB>label<TAB>admitPub<TAB>commit<TAB>leaf|skip` rows for one block, in order.
  pub(crate) fn notes(&self, label: &str) -> Vec<(crate::leaf::ChainNote, Option<String>)> {
    self
      .rows
      .iter()
      .filter(|row| row[0] == "note" && row[1] == label)
      .map(|row| {
        let note = crate::leaf::ChainNote { admit_pub: unhex32(&row[2]), commit: unhex32(&row[3]) };
        (note, if row[4] == "skip" { None } else { Some(row[4].clone()) })
      })
      .collect()
  }
}
