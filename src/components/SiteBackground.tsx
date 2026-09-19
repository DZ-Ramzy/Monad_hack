import LightTunnel from './LightTunnel'

/**
 * The tunnel of light behind the whole site.
 *
 * It mounts once, above the router split in main.tsx, so the WebGL context
 * survives the boot -> app -> error phase changes instead of being torn down
 * and rebuilt each time App swaps what it returns.
 */
export default function SiteBackground() {
  return (
    <div className="site-bg" aria-hidden="true">
      <LightTunnel
        cableColor="#A855F7"
        pulseColor="#A855F7"
        tunnelColor="#5227FF"
        tunnelOpacity={0}
        speed={0.1}
        flowDirection="outward"
        pulseSpeed={2}
        pulseLength={0.28}
        pulseBlend={1}
        pulseWidth={1}
        cableCount={20}
        thickness={0.35}
        rimWidth={0.15}
        waviness={0.3}
        sway={0.5}
        size={1}
        centerX={0}
        centerY={0}
        glow={1}
        fadeNear={0.5}
        fadeFar={2}
        brightness={1}
        colorVariance
        grain
        grainIntensity={0.05}
        opacity={1}
        mouseInteraction
        mouseStrength={0.1}
      />
    </div>
  )
}
