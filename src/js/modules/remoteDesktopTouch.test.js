import { describe, expect, it } from 'vitest';
import {
  accelerateTrackpadDelta,
  consumeScrollDelta,
  isDoubleTap,
  nextPinchTransform,
  remoteCursorPoint,
} from './remoteDesktopTouch.js';

describe('remote desktop touch controls', () => {
  it('keeps slow movement precise and accelerates fast swipes', () => {
    const precise = accelerateTrackpadDelta(2, 0, 16);
    const fast = accelerateTrackpadDelta(24, 0, 16);
    expect(precise.x).toBeCloseTo(2, 3);
    expect(fast.x).toBeGreaterThan(40);
  });

  it('retains sub-threshold two-finger scroll movement', () => {
    const first = consumeScrollDelta({ x: 0, y: 0 }, 0, 11, 20);
    expect(first.stepsY).toBe(0);
    expect(first.remainder.y).toBe(11);
    const second = consumeScrollDelta(first.remainder, 0, 11, 20);
    expect(second.stepsY).toBe(1);
    expect(second.remainder.y).toBe(2);
  });

  it('requires double taps to be close in time and space', () => {
    const previous = { at: 1_000, x: 20, y: 30 };
    expect(isDoubleTap(previous, { at: 1_250, x: 30, y: 36 })).toBe(true);
    expect(isDoubleTap(previous, { at: 1_500, x: 30, y: 36 })).toBe(false);
    expect(isDoubleTap(previous, { at: 1_200, x: 90, y: 90 })).toBe(false);
  });

  it('keeps the pinch focal point stable while zooming', () => {
    const next = nextPinchTransform(
      { scale: 1, x: 0, y: 0 },
      { x: 100, y: 200 },
      { x: 100, y: 200 },
      100,
      200,
      { width: 400, height: 800 },
    );
    expect(next).toEqual({ scale: 2, x: -100, y: -200 });
  });

  it('maps the remote cursor inside contain letterboxing and local zoom', () => {
    const point = remoteCursorPoint(
      { x: 0.5, y: 0.5 },
      { width: 400, height: 800 },
      { width: 1920, height: 1080 },
      'contain',
      { scale: 2, x: -200, y: -400 },
    );
    expect(point.x).toBeCloseTo(200);
    expect(point.y).toBeCloseTo(400);
  });
});
