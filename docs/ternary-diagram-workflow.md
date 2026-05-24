# Ternary Diagram Workflow for EOS Phase Behavior

This document explains how to create a PVTi-style ternary diagram from a reservoir fluid composition, pressure, and temperature.

The goal is to calculate:

- feed point `z`
- liquid equilibrium point `x`
- vapor equilibrium point `y`
- tie-lines
- bubble/dew binodal curves
- plait/critical point estimate
- ternary projection into `Light / Intermediate / Heavy`

---

## 1. Input Data

Use a multi-component fluid, for example 10 components:

| Component | zi |
|---|---:|
| N2 | 0.02 |
| CO2 | 0.03 |
| C1 | 0.40 |
| C2 | 0.10 |
| C3 | 0.08 |
| i-C4 | 0.05 |
| n-C4 | 0.05 |
| C5 | 0.07 |
| C6 | 0.10 |
| C7+ | 0.10 |

Check:

```text
sum(zi) = 1.00
```

Also define:

```text
Reservoir temperature T
Plot pressure P
Critical properties Tc, Pc
Acentric factor omega
Binary interaction coefficients kij
```

---

## 2. Group Components for Ternary Plot

The EOS flash is done with all components. The ternary plot is only a projection.

Use this grouping:

```text
Light = N2 + CO2 + C1
Intermediate = C2 + C3 + i-C4 + n-C4
Heavy = C5 + C6 + C7+
```

For the feed example:

```text
Light = 0.02 + 0.03 + 0.40 = 0.45
Intermediate = 0.10 + 0.08 + 0.05 + 0.05 = 0.28
Heavy = 0.07 + 0.10 + 0.10 = 0.27
```

So the feed ternary point is:

```text
z_ternary = (Light, Intermediate, Heavy)
z_ternary = (0.45, 0.28, 0.27)
```

---

## 3. Peng-Robinson EOS

Use the Peng-Robinson equation:

```text
P = RT / (V - b) - a alpha / [V(V + b) + b(V - b)]
```

For each pure component:

```text
ai = 0.45724 R^2 Tci^2 / Pci
bi = 0.07780 R Tci / Pci
```

Temperature correction:

```text
alpha_i = [1 + m_i(1 - sqrt(T / Tci))]^2
m_i = 0.37464 + 1.54226 omega_i - 0.26992 omega_i^2
```

Corrected attraction parameter:

```text
ai_alpha = ai alpha_i
```

---

## 4. Initial K-Values

Start with Wilson K-values:

```text
Ki = (Pci / P) exp[5.37(1 + omega_i)(1 - Tci / T)]
```

Example at a fixed `P, T`, assume the first iteration gives:

| Component | Ki |
|---|---:|
| N2 | 8.0 |
| CO2 | 2.5 |
| C1 | 3.2 |
| C2 | 1.5 |
| C3 | 0.8 |
| i-C4 | 0.5 |
| n-C4 | 0.4 |
| C5 | 0.2 |
| C6 | 0.1 |
| C7+ | 0.02 |

These are only initial guesses. Final K-values must come from fugacity equality.

---

## 5. Vapor Fraction by Rachford-Rice

Solve vapor fraction `V`:

```text
F(V) = sum[ zi(Ki - 1) / (1 + V(Ki - 1)) ] = 0
```

Use Newton or bisection.

Once `V` is found:

```text
xi = zi / [1 + V(Ki - 1)]
yi = Ki xi
```

Normalize:

```text
sum(xi) = 1
sum(yi) = 1
```

Example result:

```text
V = 0.62
```

For methane:

```text
z_C1 = 0.40
K_C1 = 3.2

x_C1 = 0.40 / [1 + 0.62(3.2 - 1)]
x_C1 = 0.40 / 2.364
x_C1 = 0.169

y_C1 = 3.2 * 0.169
y_C1 = 0.541
```

This is repeated for every component.

---

## 6. EOS Mixing Rules

For a phase composition `w`, where `w` can be liquid `x` or vapor `y`:

```text
a_mix = sum_i sum_j wi wj sqrt(ai aj)(1 - kij)
b_mix = sum_i wi bi
```

Reduced EOS parameters:

```text
A = a_mix P / (R^2 T^2)
B = b_mix P / (RT)
```

---

## 7. Solve Cubic EOS for Z-Factors

Peng-Robinson cubic in `Z`:

```text
Z^3 - (1 - B)Z^2 + (A - 3B^2 - 2B)Z - (AB - B^2 - B^3) = 0
```

Use:

```text
Smallest real root = liquid Z
Largest real root = vapor Z
```

Example:

```text
Z_liquid = 0.42
Z_vapor = 0.91
```

---

## 8. Fugacity Coefficients

For Peng-Robinson:

```text
ln(phi_i) =
bi/b_mix (Z - 1)
- ln(Z - B)
- A/(2 sqrt(2) B)
  [2 sum_j wj aij / a_mix - bi/b_mix]
  ln[(Z + (1 + sqrt(2))B) / (Z + (1 - sqrt(2))B)]
```

Where:

```text
aij = sqrt(ai aj)(1 - kij)
```

Calculate fugacity coefficients for both phases:

```text
phi_i^L
phi_i^V
```

Equilibrium condition:

```text
f_i^L = f_i^V
```

Because:

```text
f_i^L = xi phi_i^L P
f_i^V = yi phi_i^V P
```

Then:

```text
Ki_new = yi / xi = phi_i^L / phi_i^V
```

---

## 9. Flash Iteration Loop

Repeat:

```text
1. Guess Ki
2. Solve Rachford-Rice for V
3. Calculate xi and yi
4. Calculate EOS Z-factors
5. Calculate phi_i^L and phi_i^V
6. Update Ki = phi_i^L / phi_i^V
7. Check convergence
```

Convergence criterion:

```text
max | ln(Ki_new / Ki_old) | < tolerance
```

Typical tolerance:

```text
1e-4
```

Final outputs:

```text
V, x_i, y_i, K_i, Z_liquid, Z_vapor
```

---

## 10. Convert x and y to Ternary Points

After flash convergence, reduce liquid and vapor compositions:

```text
x_light = x_N2 + x_CO2 + x_C1
x_intermediate = x_C2 + x_C3 + x_iC4 + x_nC4
x_heavy = x_C5 + x_C6 + x_C7+
```

Same for vapor:

```text
y_light = y_N2 + y_CO2 + y_C1
y_intermediate = y_C2 + y_C3 + y_iC4 + y_nC4
y_heavy = y_C5 + y_C6 + y_C7+
```

Example:

| Point | Light | Intermediate | Heavy |
|---|---:|---:|---:|
| Feed z | 0.45 | 0.28 | 0.27 |
| Liquid x | 0.32 | 0.25 | 0.43 |
| Vapor y | 0.78 | 0.18 | 0.04 |

---

## 11. Convert Ternary Coordinates to x-y Plot Coordinates

Let the triangle vertices be:

```text
Light vertex        = (0.5, sqrt(3)/2)
Intermediate vertex = (1.0, 0.0)
Heavy vertex        = (0.0, 0.0)
```

For a ternary point:

```text
L + I + H = 1
```

Convert to Cartesian coordinates:

```text
X = 0.5 L + 1.0 I + 0.0 H
Y = sqrt(3)/2 L
```

Example feed:

```text
L = 0.45
I = 0.28
H = 0.27

X = 0.5(0.45) + 1.0(0.28)
X = 0.505

Y = 0.866(0.45)
Y = 0.390
```

So:

```text
Feed plot point = (0.505, 0.390)
```

---

## 12. Draw One Tie-Line

A tie-line connects the equilibrium liquid and vapor compositions:

```text
line from x_ternary to y_ternary
```

Parametric equation:

```text
r(t) = x + t(y - x)
0 <= t <= 1
```

If:

```text
x = (0.32, 0.25, 0.43)
y = (0.78, 0.18, 0.04)
```

Then:

```text
r(t) =
(
  0.32 + t(0.78 - 0.32),
  0.25 + t(0.18 - 0.25),
  0.43 + t(0.04 - 0.43)
)
```

At `t = 0.5`:

```text
r(0.5) = (0.55, 0.215, 0.235)
```

---

## 13. Draw Bubble and Dew Curves

To build a PVTi-style ternary diagram at one pressure:

1. Generate many feed compositions across the ternary triangle.
2. Convert each ternary feed point back into 10-component composition.
3. Run EOS flash for each composition.
4. Keep only two-phase flashes:

```text
0 < V < 1
```

5. Store:

```text
liquid endpoint x_ternary
vapor endpoint y_ternary
```

6. The set of liquid endpoints forms the bubble curve.
7. The set of vapor endpoints forms the dew curve.
8. Each matching pair `(x, y)` forms one tie-line.

Important:

```text
Do not connect random bubble and dew points.
Tie-lines must connect x and y from the same EOS flash.
```

---

## 14. Plait Point

The plait point is where the two phases become identical:

```text
x = y
```

So the tie-line length becomes zero:

```text
distance = sqrt[(x_L - y_L)^2 + (x_I - y_I)^2 + (x_H - y_H)^2]
```

In a numerical implementation, estimate the plait point as the shortest tie-line:

```text
plait tie-line = min distance(x_ternary, y_ternary)
```

Approximate plait point:

```text
plait = 0.5(x_ternary + y_ternary)
```

Commercial PVTi software uses continuation and stability analysis, so its plait point is smoother and more exact.

---

## 15. Full Algorithm Summary

```text
INPUT:
  zi, P, T, Tc, Pc, omega, kij

EOS FLASH:
  calculate Wilson Ki
  solve Rachford-Rice
  calculate x and y
  calculate EOS Z roots
  calculate fugacity coefficients
  update Ki
  iterate to convergence

TERNARY REDUCTION:
  Light = N2 + CO2 + C1
  Intermediate = C2-C4
  Heavy = C5+

PLOT:
  feed point z
  liquid point x
  vapor point y
  tie-line x-y

PVTi-STYLE ENVELOPE:
  scan many ternary feed compositions
  flash each feed
  keep two-phase flashes
  draw liquid endpoints as bubble curve
  draw vapor endpoints as dew curve
  draw matched tie-lines
  estimate plait point from shortest tie-line
```

---

## 16. Practical Notes

- A ternary diagram is not calculated from only one feed composition.
- One feed composition gives one tie-line.
- The full two-phase region needs many flashes over the ternary composition space.
- The pressure is fixed for one ternary diagram.
- Changing pressure creates a different envelope.
- Bubble and dew curves must be based on matched EOS equilibrium results.
- Tie-line spacing can be made visually uniform, but the endpoints must still come from matched flash pairs.
- PVTi is smoother because it uses continuation methods rather than a simple rectangular composition grid.

