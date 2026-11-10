import { AbsoluteFill, Composition, Sequence, interpolate, registerRoot, useCurrentFrame } from "raea";

function Card({ text, bg }: { text: string; bg: string }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: bg, color: "#fff", justifyContent: "center", alignItems: "center", fontSize: 120 }}>
      <span style={{ opacity: o }}>{text}</span>
    </AbsoluteFill>
  );
}

function Piece() {
  return (
    <>
      <Sequence from={0} durationInFrames={45}><Card text="Hello Felix" bg="#0b3d91" /></Sequence>
      <Sequence from={45} durationInFrames={45}><Card text="raea works" bg="#7a1fa2" /></Sequence>
    </>
  );
}

registerRoot(() => <Composition id="piece" component={Piece} width={1280} height={720} fps={30} durationInFrames={90} />);
