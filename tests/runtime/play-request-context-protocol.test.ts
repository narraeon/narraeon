import { expect, test } from "vitest";
import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("historical context command validates its world, chain and event identity", () => {
  const request = {
    type: "play.timeline.context",
    worldId: "world",
    chainId: "chain",
    eventId: 2,
  };
  expect(parseV1Envelope({ protocol: v1Protocol, request }).request).toEqual(
    request,
  );
  for (const eventId of [0, -1, 1.5, NaN])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: { ...request, eventId },
      }),
    ).toThrow();
  for (const field of ["chainId", "worldId"])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: { ...request, [field]: undefined },
      }),
    ).toThrow();
});
