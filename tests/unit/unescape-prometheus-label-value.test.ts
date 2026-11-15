import { unescapePrometheusLabelValue } from '../../nodes/Observability/operations/index';

/**
 * THE DEFECT THIS PINS (js/double-escaping).
 *
 * Label values used to be decoded by three chained replaces:
 *   .replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n")
 * The second pass turns `\\` into `\`, and the third then reads the following
 * `n` as a fresh escape. Prometheus encodes a literal backslash-then-n as
 * `\\n`, so that input was decoded to a real newline — a value was unescaped
 * twice. One left-to-right scan with a single escape table cannot do that.
 */

describe('unescapePrometheusLabelValue', () => {
  it('returns a value with no escapes unchanged', () => {
    expect(unescapePrometheusLabelValue('plain-value-123')).toBe('plain-value-123');
    expect(unescapePrometheusLabelValue('')).toBe('');
  });

  it('decodes each Prometheus escape exactly once', () => {
    expect(unescapePrometheusLabelValue('say \\"hi\\"')).toBe('say "hi"');
    expect(unescapePrometheusLabelValue('C:\\\\tmp')).toBe('C:\\tmp');
    expect(unescapePrometheusLabelValue('line1\\nline2')).toBe('line1\nline2');
  });

  it('does NOT decode an escaped backslash followed by n as a newline', () => {
    // Encoded `\\n` is a literal backslash then 'n'. The old chain produced '\n'.
    const decoded = unescapePrometheusLabelValue('a\\\\nb');
    expect(decoded).toBe('a\\nb');
    expect(decoded).not.toBe('a\nb');
  });

  it('treats backslashes in pairs, left to right', () => {
    // Four backslashes are two escaped backslashes -> two literal backslashes.
    expect(unescapePrometheusLabelValue('\\\\\\\\')).toBe('\\\\');
    // `\\\"` is an escaped backslash then an escaped quote.
    expect(unescapePrometheusLabelValue('\\\\\\"')).toBe('\\"');
  });

  it('keeps unknown escapes and a trailing lone backslash verbatim', () => {
    expect(unescapePrometheusLabelValue('a\\tb')).toBe('a\\tb');
    expect(unescapePrometheusLabelValue('trailing\\')).toBe('trailing\\');
  });

  it('decodes a realistic label body in one pass', () => {
    const encoded = 'path="C:\\\\tmp",note="say \\"hi\\"\\nnext"';
    expect(unescapePrometheusLabelValue(encoded)).toBe(
      'path="C:\\tmp",note="say "hi"\nnext"',
    );
  });
});
