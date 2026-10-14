//! CT-7. `prove` and `verify` start no thread. `prove_threaded` joins every
//! thread it starts before it returns.
//!
//! This file holds one test, so the process has the main thread and one test
//! thread while it runs. The thread count is read from `/proc/self/task`.

use shear_fs1::{prove, prove_threaded, verify, Fs1Params, OpenNote, Tree, NOTE_PAYMENT};

fn threads() -> usize {
  std::fs::read_dir("/proc/self/task").map(|dir| dir.count()).unwrap_or(0)
}

#[test]
fn ct7_prove_and_verify_run_on_the_calling_thread() {
  if cfg!(not(target_os = "linux")) {
    return;
  }
  let params = Fs1Params::fixed().expect("params");
  let tree = Tree::build(&params, 30, 1).expect("tree");
  let before = threads();
  assert!(before >= 1);
  let notes = [
    OpenNote { leaf_index: 3, note_age: 0, set_size: 30, note_type: NOTE_PAYMENT, anchor: [0; 32] },
    OpenNote { leaf_index: 20, note_age: 9, set_size: 30, note_type: NOTE_PAYMENT, anchor: [0; 32] },
  ];
  let proved = prove(&params, &tree, &notes).expect("prove");
  assert_eq!(threads(), before);
  verify(&params, &proved).expect("verify");
  assert_eq!(threads(), before);
  let proved = prove_threaded(&params, &tree, &notes, 4).expect("threaded prove");
  assert_eq!(threads(), before);
  verify(&params, &proved).expect("verify");
  assert_eq!(threads(), before);
}
