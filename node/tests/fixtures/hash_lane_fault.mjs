// Preloaded with --import. Acts only inside a ShearHash lane child, and only
// for the fault named in SHEAR_TEST_LANE_FAULT. The node process is untouched.
const argv1 = String(process.argv[1] || '').replace(/\\/g, '/');
const lane = argv1.endsWith('/crypto/hash_offloop_child.js');
const fault = String(process.env.SHEAR_TEST_LANE_FAULT || '');

if (lane && fault === 'crash') {
  process.stdin.once('data', () => process.exit(70));
}

if (lane && fault === 'native') {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(
    String(chunk).replace(/^(\d+)\t[0-9a-f]{64}\n$/, '$1\tERR\tnative addon missing\n'),
    ...rest,
  );
}

if (lane && fault === 'hang') {
  process.stdout.write = () => true;
}
