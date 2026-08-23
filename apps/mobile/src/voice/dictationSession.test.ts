// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACCUMULATOR,
  SEGMENT_RESTART_DELAY_MS,
  applyResultEvent,
  composeDisplay,
  composeSessionFlush,
  composeText,
  decideEndEvent,
  resetSegments,
  type TranscriptAccumulator,
} from './dictationSession';
import { SILENCE_AUTO_STOP_AFTER } from './sttErrorPolicy';

const acc = (over: Partial<TranscriptAccumulator> = {}): TranscriptAccumulator => ({
  ...EMPTY_ACCUMULATOR,
  ...over,
});

// Baseline `end` input: active on-device session, no latch, no flush, no
// accrued silence. Tests override only what each scenario changes.
const endInput = (over: Partial<Parameters<typeof decideEndEvent>[1]> = {}) => ({
  pressActive: true,
  activeEngineOnDevice: true,
  errorHandlingLatched: false,
  flushedExternally: false,
  consecutiveSilentEnds: 0,
  ...over,
});

describe('composeText / composeSessionFlush / composeDisplay', () => {
  it('joins finals and appends the interim', () => {
    const a = acc({ finalSegments: ['hello there', 'second bit'], interim: 'and more' });
    expect(composeText(a)).toBe('hello there second bit and more');
  });

  it('returns just the interim when no finals exist', () => {
    expect(composeText(acc({ interim: 'partial words' }))).toBe('partial words');
  });

  it('returns empty for an empty accumulator', () => {
    expect(composeText(EMPTY_ACCUMULATOR)).toBe('');
  });

  it('flush prepends folded sessionText and promotes the interim', () => {
    const a = acc({ sessionText: 'earlier segment', finalSegments: ['now'], interim: 'ish' });
    expect(composeSessionFlush(a)).toBe('earlier segment now ish');
  });

  it('flush falls back to sessionText alone when the segment is silent', () => {
    expect(composeSessionFlush(acc({ sessionText: 'only earlier' }))).toBe('only earlier');
  });

  it('display prefixes sessionText only when present', () => {
    expect(composeDisplay(acc({ interim: 'cur' }))).toBe('cur');
    expect(composeDisplay(acc({ sessionText: 'prior', interim: 'cur' }))).toBe('prior cur');
  });

  it('resetSegments clears segments but keeps sessionText', () => {
    const a = acc({ finalSegments: ['x'], interim: 'y', sessionText: 'keep me' });
    expect(resetSegments(a)).toEqual(acc({ sessionText: 'keep me' }));
  });
});

describe('applyResultEvent', () => {
  it('drops trailing results after an external flush', () => {
    const out = applyResultEvent(acc({ finalSegments: ['kept'] }), {
      transcript: 'straggler',
      isFinal: true,
      flushedExternally: true,
    });
    expect(out).toEqual({ type: 'ignore-flushed' });
  });

  it('ignores empty/undefined transcripts', () => {
    expect(
      applyResultEvent(acc(), { transcript: undefined, isFinal: false, flushedExternally: false }),
    ).toEqual({ type: 'ignore-empty' });
    expect(
      applyResultEvent(acc(), { transcript: '', isFinal: true, flushedExternally: false }),
    ).toEqual({ type: 'ignore-empty' });
  });

  it('a final result appends a segment, clears the interim, and resets the silent counter', () => {
    const out = applyResultEvent(acc({ finalSegments: ['one'], interim: 'stale' }), {
      transcript: 'two',
      isFinal: true,
      flushedExternally: false,
    });
    expect(out).toMatchObject({
      type: 'accumulate',
      acc: { finalSegments: ['one', 'two'], interim: '' },
      display: 'one two',
      resetsSilentEnds: true,
    });
  });

  it('a non-final result overwrites the interim and does NOT reset the silent counter', () => {
    const start = acc({ finalSegments: ['one'], interim: 'old partial' });
    const out = applyResultEvent(start, {
      transcript: 'new partial',
      isFinal: false,
      flushedExternally: false,
    });
    expect(out).toMatchObject({
      type: 'accumulate',
      acc: { finalSegments: ['one'], interim: 'new partial' },
      display: 'one new partial',
      resetsSilentEnds: false,
    });
    // Immutability: the input accumulator is untouched.
    expect(start.interim).toBe('old partial');
  });

  it('display includes prior folded sessionText', () => {
    const out = applyResultEvent(acc({ sessionText: 'earlier words' }), {
      transcript: 'now',
      isFinal: false,
      flushedExternally: false,
    });
    expect(out).toMatchObject({ type: 'accumulate', display: 'earlier words now' });
  });
});

describe('decideEndEvent — active on-device session', () => {
  it('does NOTHING while the error latch is held (3309ef6: error owns the restart)', () => {
    const out = decideEndEvent(acc({ finalSegments: ['text that must not be folded twice'] }),
      endInput({ errorHandlingLatched: true }));
    expect(out).toEqual({ type: 'ignore-latched' });
  });

  it('the latch beats even a flushed-externally end during an active session', () => {
    const out = decideEndEvent(acc(), endInput({ errorHandlingLatched: true, flushedExternally: true }));
    expect(out).toEqual({ type: 'ignore-latched' });
  });

  it('folds segment text into sessionText, zeroes the silent counter, and restarts', () => {
    const out = decideEndEvent(
      acc({ sessionText: 'first chunk', finalSegments: ['second'], interim: 'chunk' }),
      endInput({ consecutiveSilentEnds: 1 }),
    );
    expect(out).toEqual({
      type: 'fold-and-restart',
      acc: acc({ sessionText: 'first chunk second chunk' }),
      consecutiveSilentEnds: 0,
      restartDelayMs: SEGMENT_RESTART_DELAY_MS,
    });
  });

  it('starts sessionText from the segment text when nothing was folded yet', () => {
    const out = decideEndEvent(acc({ finalSegments: ['only text'] }), endInput());
    expect(out).toMatchObject({ type: 'fold-and-restart', acc: acc({ sessionText: 'only text' }) });
  });

  it('a silent end below the threshold increments the counter and restarts', () => {
    const out = decideEndEvent(acc({ sessionText: 'kept' }), endInput());
    expect(out).toEqual({
      type: 'restart-after-silence',
      acc: acc({ sessionText: 'kept' }),
      consecutiveSilentEnds: 1,
      restartDelayMs: SEGMENT_RESTART_DELAY_MS,
    });
  });

  it(`auto-stops after ${SILENCE_AUTO_STOP_AFTER} consecutive silent ends, flushing the folded text`, () => {
    const out = decideEndEvent(
      acc({ sessionText: 'said before the quiet' }),
      endInput({ consecutiveSilentEnds: SILENCE_AUTO_STOP_AFTER - 1 }),
    );
    expect(out).toEqual({ type: 'auto-stop-commit', finalText: 'said before the quiet' });
  });

  it('auto-stops with an empty flush when nothing was ever said', () => {
    const out = decideEndEvent(
      acc(),
      endInput({ consecutiveSilentEnds: SILENCE_AUTO_STOP_AFTER - 1 }),
    );
    expect(out).toEqual({ type: 'auto-stop-commit', finalText: '' });
  });

  it('any text in the segment defers auto-stop even at the threshold', () => {
    const out = decideEndEvent(
      acc({ interim: 'late words' }),
      endInput({ consecutiveSilentEnds: SILENCE_AUTO_STOP_AFTER - 1 }),
    );
    expect(out).toMatchObject({ type: 'fold-and-restart', consecutiveSilentEnds: 0 });
  });
});

describe('decideEndEvent — inactive session (stop tapped / flushed / other engine)', () => {
  it('tears down without re-emitting after an external stopAndFlush', () => {
    const out = decideEndEvent(
      acc({ sessionText: 'already committed elsewhere' }),
      endInput({ pressActive: false, flushedExternally: true }),
    );
    expect(out).toEqual({ type: 'teardown-flushed' });
  });

  it('commits the composed transcript on a user stop tap', () => {
    const out = decideEndEvent(
      acc({ sessionText: 'first', finalSegments: ['second'], interim: 'third' }),
      endInput({ pressActive: false }),
    );
    expect(out).toEqual({ type: 'commit-final', finalText: 'first second third' });
  });

  it('commits an empty finalText (caller skips the emit) when nothing was said', () => {
    const out = decideEndEvent(acc(), endInput({ pressActive: false }));
    expect(out).toEqual({ type: 'commit-final', finalText: '' });
  });

  it('an active session on a non-ondevice engine falls through to commit, not restart', () => {
    // Guards the pressActive && activeEngineOnDevice conjunction: pressActive
    // alone must not trigger the segment-restart branch.
    const out = decideEndEvent(
      acc({ finalSegments: ['words'] }),
      endInput({ activeEngineOnDevice: false }),
    );
    expect(out).toEqual({ type: 'commit-final', finalText: 'words' });
  });
});

describe('interplay sequences (error-before-end ordering, flush races)', () => {
  it('error → end: latched end is inert, so only the error ladder restarts', () => {
    // The error listener latches before `end` arrives (native ordering).
    const afterError = decideEndEvent(acc({ interim: 'partial' }), endInput({ errorHandlingLatched: true }));
    expect(afterError).toEqual({ type: 'ignore-latched' });
    // Once the retried session's native `start` resets the latch, a later
    // silent end behaves normally again.
    const nextEnd = decideEndEvent(acc({ interim: 'partial' }), endInput());
    expect(nextEnd).toMatchObject({ type: 'fold-and-restart' });
  });

  it('stopAndFlush → trailing result → end: nothing re-accumulates or re-commits', () => {
    // stopAndFlush cleared the accumulator and set the flushed guard;
    // pressActive is already false.
    const trailing = applyResultEvent(EMPTY_ACCUMULATOR, {
      transcript: 'teardown straggler',
      isFinal: true,
      flushedExternally: true,
    });
    expect(trailing).toEqual({ type: 'ignore-flushed' });
    const end = decideEndEvent(
      EMPTY_ACCUMULATOR,
      endInput({ pressActive: false, flushedExternally: true }),
    );
    expect(end).toEqual({ type: 'teardown-flushed' });
  });

  it('silence auto-stop path: silent end, silent end → auto-stop with folded text', () => {
    let a = acc();
    // Segment 1 produces text and self-ends.
    const r1 = applyResultEvent(a, { transcript: 'note to self', isFinal: true, flushedExternally: false });
    if (r1.type !== 'accumulate') throw new Error('expected accumulate');
    a = r1.acc;
    const e1 = decideEndEvent(a, endInput());
    if (e1.type !== 'fold-and-restart') throw new Error('expected fold-and-restart');
    a = e1.acc;
    // Segments 2 and 3 are silent.
    const e2 = decideEndEvent(a, endInput({ consecutiveSilentEnds: e1.consecutiveSilentEnds }));
    if (e2.type !== 'restart-after-silence') throw new Error('expected restart-after-silence');
    a = e2.acc;
    const e3 = decideEndEvent(a, endInput({ consecutiveSilentEnds: e2.consecutiveSilentEnds }));
    expect(e3).toEqual({ type: 'auto-stop-commit', finalText: 'note to self' });
  });

  it('a final mid-way resets the silence run, extending the session', () => {
    // One silent end...
    const e1 = decideEndEvent(acc(), endInput());
    if (e1.type !== 'restart-after-silence') throw new Error('expected restart-after-silence');
    // ...then speech finalizes: the result outcome tells the caller to zero
    // the counter, so the NEXT silent end is #1 again, not #2.
    const r = applyResultEvent(e1.acc, { transcript: 'spoke again', isFinal: true, flushedExternally: false });
    expect(r).toMatchObject({ type: 'accumulate', resetsSilentEnds: true });
    const e2 = decideEndEvent(resetSegments(e1.acc), endInput({ consecutiveSilentEnds: 0 }));
    expect(e2).toMatchObject({ type: 'restart-after-silence', consecutiveSilentEnds: 1 });
  });
});
