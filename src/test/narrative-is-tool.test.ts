/**
 * narrative-is-tool.test.ts — proving the unification.
 *
 * The substrate's claim: a narrative with non-concrete inner terms IS
 * a tool definition before it mounts. Holes are param positions;
 * filling them is invocation; the rendered text is the result.
 *
 * `template(text)` is a TYPE constructor — it parses the text into a
 * `kind:'string'` Type with `segment` constraints, where each `{{path}}`
 * becomes a segment whose inner Type is a string with a `ref(path)`
 * constraint. The kernel sees only segments + refs; the same cascade
 * machinery that drives derived rules drives the narrative's reflow.
 * No special template op.
 */

import { Sequence } from '../sequence';
import { template } from '..';

describe('narrative with holes is a tool', () => {
  test('mount template with no holes filled — text shows the holes verbatim', () => {
    const seq = new Sequence();
    seq.mount('schema', 'greeting.text',
      template('Hello {{greeting.user}}, welcome to {{greeting.place}}.'));
    expect(seq.get('greeting.text')).toBe('Hello {{greeting.user}}, welcome to {{greeting.place}}.');
  });

  test('filling a hole narrows the narrative — same cascade as derived', () => {
    const seq = new Sequence();
    seq.mount('schema', 'greeting.text',
      template('Hello {{greeting.user}}, welcome to {{greeting.place}}.'));

    seq.mount('bind', 'greeting.user', 'alice');
    expect(seq.get('greeting.text')).toBe('Hello alice, welcome to {{greeting.place}}.');

    seq.mount('bind', 'greeting.place', 'office');
    expect(seq.get('greeting.text')).toBe('Hello alice, welcome to office.');
  });

  test('mount template AFTER holes are concrete — initial narrowing seeds correctly', () => {
    const seq = new Sequence();
    seq.mount('bind', 'greeting.user', 'bob');
    seq.mount('bind', 'greeting.place', 'cafe');

    seq.mount('schema', 'greeting.text',
      template('Hi {{greeting.user}} at {{greeting.place}}!'));
    expect(seq.get('greeting.text')).toBe('Hi bob at cafe!');
  });

  test('changing a hole re-renders the narrative', () => {
    const seq = new Sequence();
    seq.mount('schema', 'msg', template('Count: {{counter}}'));
    seq.mount('bind', 'counter', 1);
    expect(seq.get('msg')).toBe('Count: 1');
    seq.mount('bind', 'counter', 2);
    expect(seq.get('msg')).toBe('Count: 2');
    seq.mount('bind', 'counter', 42);
    expect(seq.get('msg')).toBe('Count: 42');
  });

  test('template repeats a hole — same value substituted in every position', () => {
    const seq = new Sequence();
    seq.mount('schema', 'echo', template('{{x}} {{x}} {{x}}'));
    seq.mount('bind', 'x', 'tick');
    expect(seq.get('echo')).toBe('tick tick tick');
  });

  test('cascading narratives — one templated value feeds another templated value', () => {
    const seq = new Sequence();
    seq.mount('schema', 'narratives.a', template('Hello {{user}}'));
    seq.mount('schema', 'narratives.b', template('Wrapper says: {{narratives.a}}!'));
    seq.mount('bind', 'user', 'alice');
    expect(seq.get('narratives.a')).toBe('Hello alice');
    expect(seq.get('narratives.b')).toBe('Wrapper says: Hello alice!');
  });

  test('narrative=tool: filling holes is operationally the same as supplying tool inputs', () => {
    const seq = new Sequence();
    seq.mount('schema', 'log.entry',
      template('[{{when}}] {{who}} did {{what}}'));
    expect(seq.get('log.entry')).toBe('[{{when}}] {{who}} did {{what}}');

    seq.mount([
      { op: 'bind', path: 'when', value: '12:00' },
      { op: 'bind', path: 'who', value: 'alice' },
      { op: 'bind', path: 'what', value: 'rebooted the server' },
    ]);
    expect(seq.get('log.entry')).toBe('[12:00] alice did rebooted the server');
  });
});
