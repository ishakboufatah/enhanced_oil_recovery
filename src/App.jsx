/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import './App.css'

const WIDTH = 920
const HEIGHT = 420
const PAD = { left: 66, right: 28, top: 28, bottom: 58 }
const GAS_R = 10.7316
const SQRT_2 = Math.SQRT2
const TERNARY_SIZE = 620
const TERNARY_PAD = 54

const PVT_COMPONENTS = [
  { name: 'N2', group: 'light', tc: 227.2, pc: 492.3, omega: 0.0372, zi: 0.02 },
  { name: 'CO2', group: 'light', tc: 547.6, pc: 1071, omega: 0.225, zi: 0.03 },
  { name: 'C1', group: 'light', tc: 343.1, pc: 667.8, omega: 0.011, zi: 0.4 },
  { name: 'C2', group: 'intermediate', tc: 549.6, pc: 707.8, omega: 0.099, zi: 0.1 },
  { name: 'C3', group: 'intermediate', tc: 665.7, pc: 616.3, omega: 0.152, zi: 0.08 },
  { name: 'i-C4', group: 'intermediate', tc: 734.6, pc: 529.1, omega: 0.184, zi: 0.05 },
  { name: 'n-C4', group: 'intermediate', tc: 765.3, pc: 550.7, omega: 0.2, zi: 0.05 },
  { name: 'C5', group: 'heavy', tc: 845.4, pc: 489.5, omega: 0.251, zi: 0.07 },
  { name: 'C6', group: 'heavy', tc: 913.4, pc: 436.9, omega: 0.301, zi: 0.1 },
  { name: 'C7+', group: 'heavy', tc: 1060, pc: 360, omega: 0.49, zi: 0.1 },
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const sum = (values) => values.reduce((total, value) => total + value, 0)
const normalize = (values) => {
  const total = Math.max(sum(values), 1e-12)
  return values.map((value) => Math.max(value, 0) / total)
}

function effectiveRock(params) {
  const quality = clamp(Math.log10(params.permMd / 100), -1, 1)
  const wet = params.wettability

  return {
    ...params,
    krwEndEff: clamp(params.krwEnd * (1 + 0.18 * quality - 0.16 * wet), 0.04, 0.9),
    kroEndEff: clamp(params.kroEnd * (1 + 0.14 * quality + 0.1 * wet), 0.08, 1),
    nwEff: clamp(params.nw + 0.48 * wet - 0.18 * quality, 1.05, 6),
    noEff: clamp(params.no - 0.34 * wet - 0.14 * quality, 1.05, 6),
  }
}

function relativePermeability(sw, params) {
  const mobile = 1 - params.swc - params.sor
  const se = clamp((sw - params.swc) / mobile, 0.0001, 0.9999)
  const krw = params.krwEndEff * se ** params.nwEff
  const kro = params.kroEndEff * (1 - se) ** params.noEff
  return { se, krw, kro }
}

function capillaryPressure(sw, params) {
  const { se } = relativePermeability(sw, params)
  const permScale = Math.sqrt(100 / params.permMd)
  const wetScale = 1 + 0.42 * params.wettability
  return params.pcEntry * permScale * wetScale * (1 - se) ** params.pcExponent
}

function fractionalFlow(sw, params) {
  const { krw, kro } = relativePermeability(sw, params)
  return 1 / (1 + (params.muW / params.muO) * (kro / krw))
}

function derivative(sw, params) {
  const h = 0.0005
  const lo = Math.max(params.swc + h, sw - h)
  const hi = Math.min(1 - params.sor - h, sw + h)
  return (fractionalFlow(hi, params) - fractionalFlow(lo, params)) / (hi - lo)
}

function buildBuckleyLeverett(params, pvInjected) {
  const rock = effectiveRock(params)
  const swMin = params.swc
  const swMax = 1 - params.sor
  const samples = Array.from({ length: 360 }, (_, index) => {
    const sw = swMin + ((swMax - swMin) * index) / 359
    const relPerm = relativePermeability(sw, rock)
    return {
      sw,
      ...relPerm,
      pc: capillaryPressure(sw, rock),
      fw: fractionalFlow(sw, rock),
      dfw: derivative(sw, rock),
    }
  })

  let shock = samples[1]
  let bestError = Number.POSITIVE_INFINITY
  samples.slice(1, -1).forEach((point) => {
    const tangent = point.fw / Math.max(point.sw - swMin, 0.0001)
    const error = Math.abs(point.dfw - tangent)
    if (error < bestError && point.sw > swMin + 0.04) {
      bestError = error
      shock = point
    }
  })

  const shockSpeed = shock.fw / Math.max(shock.sw - swMin, 0.0001)
  const frontX = clamp(shockSpeed * pvInjected, 0, 1.12)
  const upstream = samples
    .filter((point) => point.sw >= shock.sw)
    .map((point) => ({
      x: clamp(point.dfw * pvInjected, 0, 1.12),
      sw: point.sw,
    }))
    .sort((a, b) => a.x - b.x)

  const profile = [
    { x: 0, sw: swMax },
    ...upstream.filter((point) => point.x <= frontX),
    { x: frontX, sw: shock.sw },
    { x: frontX, sw: swMin },
    { x: 1.12, sw: swMin },
  ]

  const shockRelPerm = relativePermeability(shock.sw, rock)

  return {
    samples,
    rock,
    profile,
    shockSaturation: shock.sw,
    shockSpeed,
    breakthroughPv: 1 / shockSpeed,
    frontX,
    mobilityRatio: (shockRelPerm.krw / params.muW) / Math.max(shockRelPerm.kro / params.muO, 0.0001),
    oilRecovered: clamp((frontX * (shock.sw - swMin)) / Math.max(1 - swMin - params.sor, 0.001), 0, 1),
  }
}

function binaryInteraction(i, j) {
  if (i === j) return 0
  const a = PVT_COMPONENTS[i]
  const b = PVT_COMPONENTS[j]
  if (a.name === 'CO2' || b.name === 'CO2') return a.group === 'heavy' || b.group === 'heavy' ? 0.12 : 0.08
  if (a.name === 'N2' || b.name === 'N2') return a.group === 'heavy' || b.group === 'heavy' ? 0.08 : 0.03
  return 0
}

function wilsonKValues(pressure, temperature) {
  return PVT_COMPONENTS.map((component) =>
    clamp(
      (component.pc / pressure) *
        Math.exp(5.37 * (1 + component.omega) * (1 - component.tc / temperature)),
      0.001,
      200,
    ),
  )
}

function solveRachfordRice(z, kValues) {
  const rr = (vaporFraction) =>
    sum(z.map((zi, index) => (zi * (kValues[index] - 1)) / (1 + vaporFraction * (kValues[index] - 1))))
  const f0 = rr(0)
  const f1 = rr(1)

  if (f0 <= 0) return 0
  if (f1 >= 0) return 1

  let low = 0
  let high = 1
  let vaporFraction = 0.5
  for (let iteration = 0; iteration < 80; iteration += 1) {
    vaporFraction = 0.5 * (low + high)
    if (rr(vaporFraction) > 0) low = vaporFraction
    else high = vaporFraction
  }
  return vaporFraction
}

function cubicRoots(a, b, c) {
  const p = b - (a * a) / 3
  const q = (2 * a ** 3) / 27 - (a * b) / 3 + c
  const discriminant = (q / 2) ** 2 + (p / 3) ** 3

  if (discriminant >= 0) {
    const sqrtD = Math.sqrt(discriminant)
    return [Math.cbrt(-q / 2 + sqrtD) + Math.cbrt(-q / 2 - sqrtD) - a / 3]
  }

  const radius = 2 * Math.sqrt(-p / 3)
  const theta = Math.acos(clamp((3 * q) / (2 * p) * Math.sqrt(-3 / p), -1, 1))
  return [0, 1, 2]
    .map((index) => radius * Math.cos((theta - 2 * Math.PI * index) / 3) - a / 3)
    .sort((left, right) => left - right)
}

function eosPureParams(pressure, temperature) {
  return PVT_COMPONENTS.map((component) => {
    const reducedTemperature = temperature / component.tc
    const m = 0.37464 + 1.54226 * component.omega - 0.26992 * component.omega ** 2
    const alpha = (1 + m * (1 - Math.sqrt(reducedTemperature))) ** 2
    return {
      a: (0.45724 * GAS_R ** 2 * component.tc ** 2 * alpha) / component.pc,
      b: (0.0778 * GAS_R * component.tc) / component.pc,
      pressure,
      temperature,
    }
  })
}

function eosPhase(moleFractions, pureParams, phase) {
  let aMix = 0
  const aijSums = pureParams.map((paramI, i) => {
    let subtotal = 0
    pureParams.forEach((paramJ, j) => {
      const aij = Math.sqrt(paramI.a * paramJ.a) * (1 - binaryInteraction(i, j))
      subtotal += moleFractions[j] * aij
      aMix += moleFractions[i] * moleFractions[j] * aij
    })
    return subtotal
  })

  const bMix = sum(moleFractions.map((xi, index) => xi * pureParams[index].b))
  const { pressure, temperature } = pureParams[0]
  const aReduced = (aMix * pressure) / (GAS_R ** 2 * temperature ** 2)
  const bReduced = (bMix * pressure) / (GAS_R * temperature)
  const roots = cubicRoots(
    -(1 - bReduced),
    aReduced - 3 * bReduced ** 2 - 2 * bReduced,
    -(aReduced * bReduced - bReduced ** 2 - bReduced ** 3),
  ).filter((root) => root > bReduced + 1e-8)
  const zFactor = phase === 'liquid' ? roots[0] ?? bReduced + 1e-6 : roots[roots.length - 1] ?? 1
  const logTerm = Math.log(
    Math.max((zFactor + (1 + SQRT_2) * bReduced) / (zFactor + (1 - SQRT_2) * bReduced), 1e-12),
  )

  const phi = pureParams.map((param, index) => {
    const biOverB = param.b / Math.max(bMix, 1e-12)
    const attractive = (2 * aijSums[index]) / Math.max(aMix, 1e-12) - biOverB
    const lnPhi =
      biOverB * (zFactor - 1) -
      Math.log(Math.max(zFactor - bReduced, 1e-12)) -
      (aReduced / Math.max(2 * SQRT_2 * bReduced, 1e-12)) * attractive * logTerm
    return clamp(Math.exp(lnPhi), 1e-8, 1e8)
  })

  return { zFactor, phi }
}

function reduceToTernary(composition) {
  const grouped = composition.reduce(
    (acc, value, index) => ({ ...acc, [PVT_COMPONENTS[index].group]: acc[PVT_COMPONENTS[index].group] + value }),
    { light: 0, intermediate: 0, heavy: 0 },
  )
  const total = grouped.light + grouped.intermediate + grouped.heavy
  return {
    light: grouped.light / total,
    intermediate: grouped.intermediate / total,
    heavy: grouped.heavy / total,
  }
}

function ternaryDistance(left, right) {
  return Math.hypot(left.light - right.light, left.intermediate - right.intermediate, left.heavy - right.heavy)
}

function componentFeedFromTernary(target, baseZi) {
  const normalizedBase = normalize(baseZi)
  const groupTotals = {
    light: sum(normalizedBase.filter((_, index) => PVT_COMPONENTS[index].group === 'light')),
    intermediate: sum(normalizedBase.filter((_, index) => PVT_COMPONENTS[index].group === 'intermediate')),
    heavy: sum(normalizedBase.filter((_, index) => PVT_COMPONENTS[index].group === 'heavy')),
  }

  return normalize(
    normalizedBase.map((zi, index) => {
      const group = PVT_COMPONENTS[index].group
      return (zi / Math.max(groupTotals[group], 1e-12)) * target[group]
    }),
  )
}

function clusterBoundary(points, selector, bins = 34) {
  if (points.length <= 3) return points
  const buckets = Array.from({ length: bins }, () => [])

  points.forEach((point) => {
    const key = clamp(selector(point), 0, 0.999999)
    buckets[Math.floor(key * bins)].push(point)
  })

  const clustered = buckets
    .filter((bucket) => bucket.length > 0)
    .map((bucket) => {
      const total = bucket.length
      return {
        light: sum(bucket.map((point) => point.light)) / total,
        intermediate: sum(bucket.map((point) => point.intermediate)) / total,
        heavy: sum(bucket.map((point) => point.heavy)) / total,
      }
    })

  return clustered
}

function resampleMatchedTieLines(tieLines, count = 22) {
  if (tieLines.length <= count) return tieLines
  const ternaryPlotX = (point) => point.intermediate + 0.5 * point.light
  const ordered = tieLines
    .slice()
    .sort((left, right) => ternaryPlotX(left.liquid) - ternaryPlotX(right.liquid))
  const minX = ternaryPlotX(ordered[0].liquid)
  const maxX = ternaryPlotX(ordered[ordered.length - 1].liquid)
  const selected = []
  const used = new Set()

  for (let index = 0; index < count; index += 1) {
    const targetX = minX + ((maxX - minX) * index) / (count - 1)
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY

    ordered.forEach((tieLine, tieLineIndex) => {
      if (used.has(tieLineIndex)) return
      const distance = Math.abs(ternaryPlotX(tieLine.liquid) - targetX)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = tieLineIndex
      }
    })

    if (bestIndex >= 0) {
      selected.push(ordered[bestIndex])
      used.add(bestIndex)
    }
  }

  return selected.sort((left, right) => ternaryPlotX(left.liquid) - ternaryPlotX(right.liquid))
}

function buildTieLineFamily(feedZi, pressure, temperature) {
  const gridDivisions = 28
  const targets = []

  for (let lightIndex = 0; lightIndex <= gridDivisions; lightIndex += 1) {
    for (let intermediateIndex = 0; intermediateIndex <= gridDivisions - lightIndex; intermediateIndex += 1) {
      const light = lightIndex / gridDivisions
      const intermediate = intermediateIndex / gridDivisions
      const heavy = 1 - light - intermediate
      if (light >= 0.02 && heavy >= 0.02) targets.push({ light, intermediate, heavy })
    }
  }

  const tieLines = targets
    .map((target) => buildPvtFlash(componentFeedFromTernary(target, feedZi), pressure, temperature))
    .filter((flash) => flash.vaporFraction > 0.002 && flash.vaporFraction < 0.998)
    .map((flash) => ({
      liquid: flash.ternary.liquid,
      vapor: flash.ternary.vapor,
      feed: flash.ternary.feed,
      length: ternaryDistance(flash.ternary.liquid, flash.ternary.vapor),
    }))
    .filter((tieLine) => tieLine.length > 0.006)
    .sort((left, right) => left.feed.light - right.feed.light || left.feed.intermediate - right.feed.intermediate)

  const criticalTieLine = tieLines.reduce(
    (best, tieLine) => (!best || tieLine.length < best.length ? tieLine : best),
    null,
  )
  const liquidBoundary = clusterBoundary(tieLines.map((line) => line.liquid), (point) => point.intermediate)
  const vaporBoundary = clusterBoundary(tieLines.map((line) => line.vapor), (point) => point.light)
  const region = tieLines.length >= 2 ? [...liquidBoundary, ...vaporBoundary.slice().reverse()] : []
  const displayedTieLines = resampleMatchedTieLines(tieLines)

  return { tieLines: displayedTieLines, criticalTieLine, liquidBoundary, vaporBoundary, region, totalTieLines: tieLines.length }
}

function estimateDewPointPressure(feedZi, temperatureF, maxPressure) {
  const z = normalize(feedZi)
  const dewFunction = (pressure) => sum(wilsonKValues(pressure, temperatureF + 459.67).map((kValue, index) => z[index] / kValue)) - 1
  const minPressure = 50
  let low = minPressure
  let high = Math.max(maxPressure, minPressure + 1)
  let fLow = dewFunction(low)
  let fHigh = dewFunction(high)

  if (fLow > 0) return { pressure: null, status: 'below-range' }
  if (fHigh < 0) return { pressure: null, status: 'above-reservoir' }

  if (fLow * fHigh > 0) {
    for (let pressure = minPressure; pressure <= high; pressure += 50) {
      const current = dewFunction(pressure)
      if (fLow * current <= 0) {
        high = pressure
        fHigh = current
        break
      }
      low = pressure
      fLow = current
    }
  }

  if (fLow * fHigh > 0) return { pressure: null, status: 'not-found' }

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = 0.5 * (low + high)
    const fMid = dewFunction(mid)
    if (fLow * fMid <= 0) {
      high = mid
      fHigh = fMid
    } else {
      low = mid
      fLow = fMid
    }
  }

  return { pressure: 0.5 * (low + high), status: 'found' }
}

function estimateBubblePointPressure(feedZi, temperatureF, maxPressure) {
  const z = normalize(feedZi)
  const bubbleFunction = (pressure) => sum(wilsonKValues(pressure, temperatureF + 459.67).map((kValue, index) => z[index] * kValue)) - 1
  const minPressure = 50
  let low = minPressure
  let high = Math.max(maxPressure, minPressure + 1)
  let fLow = bubbleFunction(low)
  let fHigh = bubbleFunction(high)

  if (fHigh > 0) return { pressure: null, status: 'above-reservoir' }
  if (fLow < 0) return { pressure: null, status: 'below-range' }

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = 0.5 * (low + high)
    const fMid = bubbleFunction(mid)
    if (fMid > 0) {
      low = mid
      fLow = fMid
    } else {
      high = mid
      fHigh = fMid
    }
  }

  return { pressure: 0.5 * (low + high), status: 'found' }
}

function buildPvtFlash(feedZi, pressure, temperatureF) {
  const z = normalize(feedZi)
  const temperature = temperatureF + 459.67
  const pureParams = eosPureParams(pressure, temperature)
  let kValues = wilsonKValues(pressure, temperature)
  let vaporFraction = 0
  let x = z
  let y = z
  let liquidEos = eosPhase(x, pureParams, 'liquid')
  let vaporEos = eosPhase(y, pureParams, 'vapor')
  let error = 1
  let iterations = 0

  for (iterations = 1; iterations <= 40; iterations += 1) {
    vaporFraction = solveRachfordRice(z, kValues)
    x = normalize(z.map((zi, index) => zi / Math.max(1 + vaporFraction * (kValues[index] - 1), 1e-12)))
    y = normalize(x.map((xi, index) => xi * kValues[index]))
    liquidEos = eosPhase(x, pureParams, 'liquid')
    vaporEos = eosPhase(y, pureParams, 'vapor')

    const nextK = liquidEos.phi.map((phiLiquid, index) => clamp(phiLiquid / vaporEos.phi[index], 0.001, 200))
    error = Math.max(...nextK.map((next, index) => Math.abs(Math.log(next / kValues[index]))))
    kValues = nextK.map((next, index) => Math.sqrt(next * kValues[index]))
    if (error < 0.0001) break
  }

  return {
    z,
    x,
    y,
    kValues,
    vaporFraction,
    liquidZ: liquidEos.zFactor,
    vaporZ: vaporEos.zFactor,
    error,
    iterations: Math.min(iterations, 40),
    ternary: {
      feed: reduceToTernary(z),
      liquid: reduceToTernary(x),
      vapor: reduceToTernary(y),
    },
  }
}

function estimateBubblePointFromFlash(feedZi, temperatureF, maxPressure) {
  const minPressure = 50
  const vaporCutoff = 0.001
  const max = Math.max(maxPressure, minPressure + 1)
  const highFlash = buildPvtFlash(feedZi, max, temperatureF)
  const lowFlash = buildPvtFlash(feedZi, minPressure, temperatureF)

  if (highFlash.vaporFraction > vaporCutoff) return { pressure: null, status: 'above-reservoir' }
  if (lowFlash.vaporFraction <= vaporCutoff) return { pressure: null, status: 'below-range' }

  let low = minPressure
  let high = max
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const mid = 0.5 * (low + high)
    const midFlash = buildPvtFlash(feedZi, mid, temperatureF)
    if (midFlash.vaporFraction > vaporCutoff) low = mid
    else high = mid
  }

  return { pressure: 0.5 * (low + high), status: 'found' }
}

function Chart({ profile, samples, shockSaturation, pvInjected }) {
  const xScale = (x) => PAD.left + (clamp(x, 0, 1.12) / 1.12) * (WIDTH - PAD.left - PAD.right)
  const yScale = (sw) => HEIGHT - PAD.bottom - sw * (HEIGHT - PAD.top - PAD.bottom)
  const shockPoint = profile[Math.max(profile.length - 3, 0)]
  const swPath = profile.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xScale(point.x)} ${yScale(point.sw)}`).join(' ')
  const fwPath = samples
    .map((point, index) => {
      const x = PAD.left + point.fw * (WIDTH - PAD.left - PAD.right)
      return `${index === 0 ? 'M' : 'L'} ${x} ${yScale(point.sw)}`
    })
    .join(' ')

  return (
    <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Buckley Leverett saturation displacement chart">
      <defs>
        <linearGradient id="waterFill" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="#1b8f83" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#d7a642" stopOpacity="0.18" />
        </linearGradient>
      </defs>

      <rect className="plot-bg" x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={`y-${tick}`}>
          <line className="grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={yScale(tick)} y2={yScale(tick)} />
          <text className="axis-text" x={PAD.left - 14} y={yScale(tick) + 4} textAnchor="end">{tick.toFixed(2)}</text>
        </g>
      ))}
      {[0, 0.28, 0.56, 0.84, 1.12].map((tick) => (
        <g key={`x-${tick}`}>
          <line className="grid-line" x1={xScale(tick)} x2={xScale(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
          <text className="axis-text" x={xScale(tick)} y={HEIGHT - PAD.bottom + 28} textAnchor="middle">{tick.toFixed(2)}</text>
        </g>
      ))}

      <path className="area" d={`${swPath} L ${xScale(1.12)} ${yScale(0)} L ${xScale(0)} ${yScale(0)} Z`} />
      <path className="fractional-flow" d={fwPath} />
      <path className="saturation-line" d={swPath} />
      <line className="shock-line" x1={xScale(shockPoint?.x ?? 0)} x2={xScale(shockPoint?.x ?? 0)} y1={yScale(0)} y2={yScale(shockSaturation)} />

      <text className="axis-label" x={WIDTH / 2} y={HEIGHT - 12} textAnchor="middle">Dimensionless distance, x/L</text>
      <text className="axis-label vertical" x={18} y={HEIGHT / 2} textAnchor="middle">Water saturation, Sw</text>
      <text className="legend saturation" x={WIDTH - 246} y={52}>Saturation profile</text>
      <text className="legend fractional" x={WIDTH - 246} y={78}>Fractional flow curve</text>
      <text className="time-badge" x={PAD.left + 18} y={PAD.top + 32}>PV injected: {pvInjected.toFixed(2)}</text>
    </svg>
  )
}

function CurvePanel({ samples, rock }) {
  const width = 520
  const height = 260
  const pad = { left: 48, right: 18, top: 18, bottom: 38 }
  const pcMax = Math.max(...samples.map((point) => point.pc), 1)
  const xScale = (sw) => pad.left + ((sw - rock.swc) / (1 - rock.sor - rock.swc)) * (width - pad.left - pad.right)
  const yScale = (value, max = 1) => height - pad.bottom - (value / max) * (height - pad.top - pad.bottom)
  const krwPath = samples.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xScale(point.sw)} ${yScale(point.krw)}`).join(' ')
  const kroPath = samples.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xScale(point.sw)} ${yScale(point.kro)}`).join(' ')
  const pcPath = samples.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xScale(point.sw)} ${yScale(point.pc, pcMax)}`).join(' ')

  return (
    <section className="curve-panel">
      <div className="panel-title">
        <h2>Rock functions</h2>
        <p>Wettability and permeability reshape relative permeability, mobility ratio, and fractional flow.</p>
      </div>
      <div className="curve-grid">
        <svg className="mini-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Relative permeability curves">
          <rect className="plot-bg" x={pad.left} y={pad.top} width={width - pad.left - pad.right} height={height - pad.top - pad.bottom} />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={yScale(tick)} y2={yScale(tick)} />
              <text className="axis-text small" x={pad.left - 10} y={yScale(tick) + 4} textAnchor="end">{tick.toFixed(2)}</text>
            </g>
          ))}
          <path className="krw-line" d={krwPath} />
          <path className="kro-line" d={kroPath} />
          <text className="axis-label small" x={width / 2} y={height - 8} textAnchor="middle">Water saturation, Sw</text>
          <text className="curve-label krw" x={width - 96} y={38}>krw</text>
          <text className="curve-label kro" x={width - 96} y={60}>kro</text>
        </svg>

        <svg className="mini-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Capillary pressure curve">
          <rect className="plot-bg" x={pad.left} y={pad.top} width={width - pad.left - pad.right} height={height - pad.top - pad.bottom} />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={yScale(tick)} y2={yScale(tick)} />
              <text className="axis-text small" x={pad.left - 10} y={yScale(tick) + 4} textAnchor="end">{(tick * pcMax).toFixed(0)}</text>
            </g>
          ))}
          <path className="pc-line" d={pcPath} />
          <text className="axis-label small" x={width / 2} y={height - 8} textAnchor="middle">Water saturation, Sw</text>
          <text className="curve-label pc" x={width - 128} y={38}>Pc, psi</text>
        </svg>
      </div>
    </section>
  )
}

function TernaryDiagram({ ternary, envelope, isTwoPhase }) {
  const height = Math.sqrt(3) * 0.5 * (TERNARY_SIZE - TERNARY_PAD * 2)
  const origin = { x: TERNARY_PAD, y: TERNARY_PAD + height }
  const right = { x: TERNARY_SIZE - TERNARY_PAD, y: TERNARY_PAD + height }
  const top = { x: TERNARY_SIZE / 2, y: TERNARY_PAD }
  const toXY = ({ light, intermediate, heavy }) => ({
    x: light * top.x + intermediate * right.x + heavy * origin.x,
    y: light * top.y + intermediate * right.y + heavy * origin.y,
  })
  const feed = toXY(ternary.feed)
  const liquid = toXY(ternary.liquid)
  const vapor = toXY(ternary.vapor)
  const regionPoints = envelope.region.map(toXY)
  const criticalTieLine = envelope.criticalTieLine
  const smoothPath = (points) => {
    if (points.length === 0) return ''
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
    const commands = [`M ${points[0].x} ${points[0].y}`]
    for (let index = 1; index < points.length - 1; index += 1) {
      const mid = {
        x: (points[index].x + points[index + 1].x) / 2,
        y: (points[index].y + points[index + 1].y) / 2,
      }
      commands.push(`Q ${points[index].x} ${points[index].y} ${mid.x} ${mid.y}`)
    }
    const last = points[points.length - 1]
    commands.push(`L ${last.x} ${last.y}`)
    return commands.join(' ')
  }
  const smoothPolygon = (points) => {
    if (points.length < 3) return ''
    return `${smoothPath(points)} Z`
  }
  const liquidBoundaryPath = smoothPath(envelope.liquidBoundary.map(toXY))
  const vaporBoundaryPath = smoothPath(envelope.vaporBoundary.map(toXY))
  const regionPath = smoothPolygon(regionPoints)
  const ticks = [0.2, 0.4, 0.6, 0.8]

  return (
    <svg className="ternary-chart" viewBox={`0 0 ${TERNARY_SIZE} ${TERNARY_SIZE}`} role="img" aria-label="PVT ternary phase diagram">
      <polygon className="ternary-bg" points={`${origin.x},${origin.y} ${right.x},${right.y} ${top.x},${top.y}`} />
      {ticks.map((tick) => {
        const lightA = toXY({ light: tick, intermediate: 1 - tick, heavy: 0 })
        const lightB = toXY({ light: tick, intermediate: 0, heavy: 1 - tick })
        const interA = toXY({ light: 1 - tick, intermediate: tick, heavy: 0 })
        const interB = toXY({ light: 0, intermediate: tick, heavy: 1 - tick })
        const heavyA = toXY({ light: 1 - tick, intermediate: 0, heavy: tick })
        const heavyB = toXY({ light: 0, intermediate: 1 - tick, heavy: tick })
        return (
          <g key={tick}>
            <line className="ternary-grid" x1={lightA.x} y1={lightA.y} x2={lightB.x} y2={lightB.y} />
            <line className="ternary-grid" x1={interA.x} y1={interA.y} x2={interB.x} y2={interB.y} />
            <line className="ternary-grid" x1={heavyA.x} y1={heavyA.y} x2={heavyB.x} y2={heavyB.y} />
          </g>
        )
      })}
      {liquidBoundaryPath && <path className="binodal liquid-binodal" d={liquidBoundaryPath} />}
      {vaporBoundaryPath && <path className="binodal vapor-binodal" d={vaporBoundaryPath} />}
      {envelope.tieLines.map((tieLine, index) => {
        const start = toXY(tieLine.liquid)
        const end = toXY(tieLine.vapor)
        return <line className="tie-line family" key={`${tieLine.feed.light}-${index}`} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
      })}
      {criticalTieLine && (() => {
        const start = toXY(criticalTieLine.liquid)
        const end = toXY(criticalTieLine.vapor)
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        return (
          <g>
            <line className="critical-tie-line" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
            <circle className="plait-point" cx={mid.x} cy={mid.y} r="5" />
            <text className="critical-label" x={mid.x + 10} y={mid.y - 8}>Plait point</text>
          </g>
        )
      })()}
      {isTwoPhase && <line className="tie-line selected" x1={liquid.x} y1={liquid.y} x2={vapor.x} y2={vapor.y} />}
      <circle className="phase-point feed-point" cx={feed.x} cy={feed.y} r="8" />
      {isTwoPhase && <circle className="phase-point liquid-point" cx={liquid.x} cy={liquid.y} r="8" />}
      {isTwoPhase && <circle className="phase-point vapor-point" cx={vapor.x} cy={vapor.y} r="8" />}
      <text className="ternary-label top" x={top.x} y={top.y - 18} textAnchor="middle">Light</text>
      <text className="ternary-label" x={origin.x - 12} y={origin.y + 30} textAnchor="middle">Heavy</text>
      <text className="ternary-label" x={right.x + 24} y={right.y + 30} textAnchor="middle">Intermediate</text>
      <text className="point-label" x={feed.x + 12} y={feed.y - 10}>Feed z</text>
      {isTwoPhase && <text className="point-label liquid" x={liquid.x + 12} y={liquid.y + 24}>Liquid x</text>}
      {isTwoPhase && <text className="point-label vapor" x={vapor.x + 12} y={vapor.y - 12}>Vapor y</text>}
    </svg>
  )
}

function NumberInput({ label, value, min, max, step = 0.01, unit = '', onChange }) {
  return (
    <label className="number-control">
      <span>{label}</span>
      <div>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        />
        {unit && <strong>{unit}</strong>}
      </div>
    </label>
  )
}

function PressureSelector({ value, min, max, step, onChange }) {
  return (
    <label className="pressure-selector">
      <span>
        Plot pressure
        <strong>{value.toFixed(0)} psia</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <div>
        <small>{min.toLocaleString()} psia</small>
        <small>{max.toLocaleString()} psia</small>
      </div>
    </label>
  )
}

function formatDewPoint(dewPoint) {
  if (dewPoint.status === 'found') return `Dewpoint ${dewPoint.pressure.toFixed(0)} psia`
  if (dewPoint.status === 'above-reservoir') return 'Dewpoint above reservoir pressure'
  if (dewPoint.status === 'below-range') return 'Dewpoint below 50 psia'
  return 'Dewpoint not bracketed'
}

function formatBubblePoint(bubblePoint) {
  if (bubblePoint.status === 'found') return `Bubblepoint ${bubblePoint.pressure.toFixed(0)} psia`
  if (bubblePoint.status === 'above-reservoir') return 'Bubblepoint above reservoir pressure'
  if (bubblePoint.status === 'below-range') return 'Bubblepoint below 50 psia'
  return 'Bubblepoint not bracketed'
}

function phaseState(vaporFraction) {
  if (vaporFraction <= 0.001) return 'Single liquid'
  if (vaporFraction >= 0.999) return 'Single vapor'
  return 'Two-phase'
}

function CompositionInput({ component, value, onChange }) {
  return (
    <label className="composition-row">
      <span>{component.name}</span>
      <input type="number" min="0" max="1" step="0.001" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function Slider({ label, value, min, max, step, unit, onChange }) {
  return (
    <label className="control">
      <span>
        {label}
        <strong>{value.toFixed(step < 0.01 ? 3 : 2)}{unit}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function BuckleyLeverettSection() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [pvInjected, setPvInjected] = useState(0.22)
  const [params, setParams] = useState({
    swc: 0.18,
    sor: 0.22,
    muW: 1,
    muO: 5,
    krwEnd: 0.32,
    kroEnd: 0.86,
    nw: 2.2,
    no: 2.4,
    permMd: 120,
    wettability: 0.35,
    pcEntry: 18,
    pcExponent: 2.1,
  })

  const model = useMemo(() => buildBuckleyLeverett(params, pvInjected), [params, pvInjected])

  useEffect(() => {
    if (!isPlaying) return undefined
    const id = window.setInterval(() => {
      setPvInjected((current) => (current >= 1.05 ? 0.04 : current + 0.012))
    }, 90)
    return () => window.clearInterval(id)
  }, [isPlaying])

  const updateParam = (key) => (value) => {
    setParams((current) => ({ ...current, [key]: value }))
  }

  return (
    <main className="app-shell">
      <section className="intro">
        <div>
          <p className="eyebrow">Enhanced oil recovery analysis</p>
          <h1>Buckley-Leverett saturation displacement</h1>
          <p>
            Explore how water saturation moves through a one-dimensional core. Adjust rock and fluid properties,
            then play the pore-volume injection to watch the displacement front evolve. Rock wettability shifts
            the relative permeability curves, which changes phase mobility and the fractional-flow shape.
          </p>
        </div>
        <div className="method-chip">Section 01</div>
      </section>

      <section className="workspace">
        <div className="chart-panel">
          <div className="chart-head">
            <div>
              <h2>Saturation profile</h2>
              <p>Shock-front solution with Corey relative permeability and fractional flow.</p>
            </div>
            <button className="play-button" onClick={() => setIsPlaying((current) => !current)}>
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
          </div>
          <Chart {...model} pvInjected={pvInjected} />
          <div className="timeline">
            <span>0 PV</span>
            <input type="range" min="0.02" max="1.1" step="0.01" value={pvInjected} onChange={(event) => setPvInjected(Number(event.target.value))} />
            <span>1.1 PV</span>
          </div>
        </div>

        <aside className="side-panel">
          <h2>Inputs</h2>
          <Slider label="Connate water, Swc" value={params.swc} min={0.05} max={0.35} step={0.01} unit="" onChange={updateParam('swc')} />
          <Slider label="Residual oil, Sor" value={params.sor} min={0.05} max={0.4} step={0.01} unit="" onChange={updateParam('sor')} />
          <Slider label="Absolute permeability" value={params.permMd} min={10} max={1000} step={10} unit=" mD" onChange={updateParam('permMd')} />
          <Slider label="Wettability index" value={params.wettability} min={-1} max={1} step={0.05} unit="" onChange={updateParam('wettability')} />
          <Slider label="Water viscosity" value={params.muW} min={0.2} max={4} step={0.1} unit=" cP" onChange={updateParam('muW')} />
          <Slider label="Oil viscosity" value={params.muO} min={1} max={30} step={0.5} unit=" cP" onChange={updateParam('muO')} />
          <Slider label="krw endpoint" value={params.krwEnd} min={0.08} max={0.8} step={0.01} unit="" onChange={updateParam('krwEnd')} />
          <Slider label="kro endpoint" value={params.kroEnd} min={0.12} max={1} step={0.01} unit="" onChange={updateParam('kroEnd')} />
          <Slider label="Water Corey exponent" value={params.nw} min={1.2} max={5} step={0.1} unit="" onChange={updateParam('nw')} />
          <Slider label="Oil Corey exponent" value={params.no} min={1.2} max={5} step={0.1} unit="" onChange={updateParam('no')} />
          <Slider label="Entry capillary pressure" value={params.pcEntry} min={2} max={80} step={1} unit=" psi" onChange={updateParam('pcEntry')} />
          <Slider label="Pc curve exponent" value={params.pcExponent} min={0.8} max={5} step={0.1} unit="" onChange={updateParam('pcExponent')} />
        </aside>
      </section>

      <CurvePanel samples={model.samples} rock={model.rock} />

      <section className="metrics">
        <article>
          <span>Shock saturation</span>
          <strong>{model.shockSaturation.toFixed(3)} Sw</strong>
        </article>
        <article>
          <span>Front position</span>
          <strong>{Math.min(model.frontX, 1).toFixed(3)} x/L</strong>
        </article>
        <article>
          <span>Breakthrough estimate</span>
          <strong>{model.breakthroughPv.toFixed(3)} PV</strong>
        </article>
        <article>
          <span>Mobility ratio</span>
          <strong>{model.mobilityRatio.toFixed(2)} M</strong>
        </article>
        <article>
          <span>Displaced oil index</span>
          <strong>{(model.oilRecovered * 100).toFixed(1)}%</strong>
        </article>
      </section>
    </main>
  )
}

function TernaryPvtSection() {
  const [reservoirPressure, setReservoirPressure] = useState(3200)
  const [plotPressure, setPlotPressure] = useState(3200)
  const [temperature, setTemperature] = useState(210)
  const [feedZi, setFeedZi] = useState(PVT_COMPONENTS.map((component) => component.zi))
  const pressure = Math.min(plotPressure, reservoirPressure)
  const flash = useMemo(() => buildPvtFlash(feedZi, pressure, temperature), [feedZi, pressure, temperature])
  const envelope = useMemo(() => buildTieLineFamily(feedZi, pressure, temperature), [feedZi, pressure, temperature])
  const dewPointPressure = useMemo(
    () => estimateDewPointPressure(feedZi, temperature, reservoirPressure),
    [feedZi, temperature, reservoirPressure],
  )
  const bubblePointPressure = useMemo(
    () => estimateBubblePointFromFlash(feedZi, temperature, reservoirPressure),
    [feedZi, temperature, reservoirPressure],
  )
  const isTwoPhase = flash.vaporFraction > 0.001 && flash.vaporFraction < 0.999
  const ziTotal = sum(feedZi)
  const updateZi = (index, value) => {
    setFeedZi((current) => current.map((zi, ziIndex) => (ziIndex === index ? clamp(value, 0, 1) : zi)))
  }
  const applyExample = () => setFeedZi(PVT_COMPONENTS.map((component) => component.zi))
  const normalizeFeed = () => setFeedZi((current) => normalize(current))
  const updateReservoirPressure = (value) => {
    setReservoirPressure(value)
    setPlotPressure((current) => Math.min(current, value))
  }

  return (
    <main className="app-shell">
      <section className="intro">
        <div>
          <p className="eyebrow">PVTi-style EOS workflow</p>
          <h1>Ternary phase diagram from reservoir fluid zi</h1>
          <p>
            Enter the 10-component feed, initial reservoir pressure, reservoir temperature, and the pressure you want
            to plot. The plot pressure is bounded by the initial reservoir pressure, then the app projects feed,
            liquid, and vapor into Light / Intermediate / Heavy ternary space.
          </p>
        </div>
        <div className="method-chip">Section 02</div>
      </section>

      <section className="workspace pvt-workspace">
        <div className="chart-panel">
          <div className="chart-head">
            <div>
              <h2>Ternary projection</h2>
              <p>Light = N2 + CO2 + C1, Intermediate = C2-C4, Heavy = C5+.</p>
            </div>
            <div className="pvt-badges">
              <span>Plot {pressure.toLocaleString()} psia</span>
              <span>{formatBubblePoint(bubblePointPressure)}</span>
              <span>{formatDewPoint(dewPointPressure)}</span>
              <span>{phaseState(flash.vaporFraction)}</span>
              <span>V = {flash.vaporFraction.toFixed(3)}</span>
              <span>{envelope.totalTieLines} tie-lines</span>
              <span>{flash.iterations} EOS loops</span>
            </div>
          </div>
          <TernaryDiagram ternary={flash.ternary} envelope={envelope} isTwoPhase={isTwoPhase} />
        </div>

        <aside className="side-panel">
          <h2>PVT inputs</h2>
          <NumberInput label="Initial reservoir pressure" value={reservoirPressure} min={300} max={12000} step={50} unit="psia" onChange={updateReservoirPressure} />
          <PressureSelector value={pressure} min={300} max={reservoirPressure} step={50} onChange={setPlotPressure} />
          <NumberInput label="Plot pressure" value={pressure} min={300} max={reservoirPressure} step={50} unit="psia" onChange={setPlotPressure} />
          <NumberInput label="Reservoir temperature" value={temperature} min={40} max={420} step={5} unit="degF" onChange={setTemperature} />
          <div className="composition-head">
            <span>Feed zi</span>
            <strong className={Math.abs(ziTotal - 1) < 0.0005 ? 'total-ok' : 'total-warn'}>sum {ziTotal.toFixed(3)}</strong>
          </div>
          <div className="composition-grid">
            {PVT_COMPONENTS.map((component, index) => (
              <CompositionInput key={component.name} component={component} value={feedZi[index]} onChange={(value) => updateZi(index, value)} />
            ))}
          </div>
          <div className="input-actions">
            <button type="button" onClick={normalizeFeed}>Normalize zi</button>
            <button type="button" onClick={applyExample}>Example fluid</button>
          </div>
        </aside>
      </section>

      <section className="pvt-output">
        <article>
          <span>Feed z</span>
          <strong>{flash.ternary.feed.light.toFixed(2)} / {flash.ternary.feed.intermediate.toFixed(2)} / {flash.ternary.feed.heavy.toFixed(2)}</strong>
        </article>
        <article>
          <span>Liquid x</span>
          <strong>{isTwoPhase ? `${flash.ternary.liquid.light.toFixed(2)} / ${flash.ternary.liquid.intermediate.toFixed(2)} / ${flash.ternary.liquid.heavy.toFixed(2)}` : 'single phase'}</strong>
        </article>
        <article>
          <span>Vapor y</span>
          <strong>{isTwoPhase ? `${flash.ternary.vapor.light.toFixed(2)} / ${flash.ternary.vapor.intermediate.toFixed(2)} / ${flash.ternary.vapor.heavy.toFixed(2)}` : 'not present'}</strong>
        </article>
        <article>
          <span>Z-factors</span>
          <strong>L {flash.liquidZ.toFixed(3)} / V {flash.vaporZ.toFixed(3)}</strong>
        </article>
        <article>
          <span>K convergence</span>
          <strong>{flash.error.toExponential(1)}</strong>
        </article>
      </section>

      <section className="composition-table">
        <div className="table-row table-head">
          <span>Comp</span>
          <span>zi</span>
          <span>xi</span>
          <span>yi</span>
          <span>K</span>
        </div>
        {PVT_COMPONENTS.map((component, index) => (
          <div className="table-row" key={component.name}>
            <span>{component.name}</span>
            <span>{flash.z[index].toFixed(4)}</span>
            <span>{isTwoPhase ? flash.x[index].toFixed(4) : flash.z[index].toFixed(4)}</span>
            <span>{isTwoPhase ? flash.y[index].toFixed(4) : '-'}</span>
            <span>{isTwoPhase ? flash.kValues[index].toFixed(3) : '-'}</span>
          </div>
        ))}
      </section>
    </main>
  )
}

function App() {
  const [section, setSection] = useState('buckley')

  return (
    <>
      <nav className="section-tabs" aria-label="Workflow sections">
        <button type="button" className={section === 'buckley' ? 'active' : ''} onClick={() => setSection('buckley')}>
          Section 01
        </button>
        <button type="button" className={section === 'pvt' ? 'active' : ''} onClick={() => setSection('pvt')}>
          Section 02
        </button>
      </nav>
      {section === 'buckley' ? <BuckleyLeverettSection /> : <TernaryPvtSection />}
    </>
  )
}

export default App
