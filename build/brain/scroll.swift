// scroll.swift — real mouse-wheel scroll via CoreGraphics.
// arg1 = vertical delta in LINES (CGEvent convention: positive = up).
// The brain passes -dy so that a positive dy from the agent scrolls DOWN.
import CoreGraphics
let dy = CommandLine.arguments.count > 1 ? (Int32(CommandLine.arguments[1]) ?? 5) : 5
if let e = CGEvent(scrollWheelEvent2: nil, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) {
  e.post(tap: .cghidEventTap)
}