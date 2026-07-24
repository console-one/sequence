# Interpolations

## Original Notes

Interpolations here are interesting because they are going to be forecasts that we electively choose as policies for time-based contract understanding of how things in a particular functions partition may work or could be assumed to work in some future, given that we don't know them. We are using historicals here to just generate a library of general regression tools or whatever that would be applied for planned futures at specific type join lattice locations.

Statistical forecasting: learning patterns from historical data and projecting them forward to fill unknown future values, with explicit uncertainty tracking. Forecasts are useful but inherently uncertain -- the system must produce estimates that are actionable while never pretending they are facts. Uncertainty compounds naturally: a forecast 3 months out is less reliable than one 1 month out, and this degradation must be visible and quantifiable.

The same interpolation framework works across different domains (financial, operational, temporal) without domain-specific hardcoding. The interpolation method (linear, exponential, seasonal) is a policy selected per path or partition, not a global setting.

## Regression Model and Derived Parameters

A regression model takes historical data points and derives trend parameters. The model's parameters are themselves derived values -- they re-derive whenever the historical data changes:

```ft
RegressionModel = {
  method: "linear" | "exponential" | "seasonal",
  slope: number,
  intercept: number,
  fitQuality: number 0..1,
  dataPoints: ref(HistoricalStream)
}

salesModel = RegressionModel
salesModel << { method: "linear", dataPoints: ref(monthlySales) }
```

The slope, intercept, and fitQuality are derived from the dataPoints. The actual regression computation (least-squares fitting, etc.) is a behavioral predicate -- the ft block expresses that these parameters exist and reference the historical data, while the computation itself happens during interpretation. When new data points arrive, the model re-derives its parameters.

FitQuality (analogous to R-squared) tells the user how well the chosen method matches the data. A fitQuality of 0.95 means the linear model explains 95% of the variance.

## Forecast Generation with Degrading Concreteness

Forecasts are generated from model parameters and project forward from the last known value. Each step forward compounds uncertainty:

```ft
Forecast = {
  step: number.integer >= 1,
  value: number,
  basedOn: ref(RegressionModel)
}

-- Month 5 forecast (1 step out)
forecast5 = Forecast
forecast5 << { step: 1, basedOn: ref(salesModel) }

-- Month 6 forecast (2 steps out)
forecast6 = Forecast
forecast6 << { step: 2, basedOn: ref(salesModel) }

-- Month 7 forecast (3 steps out)
forecast7 = Forecast
forecast7 << { step: 3, basedOn: ref(salesModel) }
```

Each forecast's value is computed as lastKnownValue + (slope * step). The concreteness of each forecast degrades with the step number -- forecast5 has higher concreteness than forecast6, which has higher than forecast7. This degradation is a multiplicative function of the model's fitQuality and the step distance: each step multiplies concreteness by a decay factor derived from how well the model fits. The concreteness degradation formula is a behavioral predicate that cannot be expressed in ft syntax but follows the principle that concreteness(step N) < concreteness(step N-1) for all N.

## Baseline Re-Anchoring

When actual data arrives for a forecasted period, the forecast is replaced and all downstream forecasts recompute from the new baseline:

```ft
-- Actual value arrives for month 5
monthlySales.entries.month5 = HistoricalEntry
monthlySales.entries.month5 << { timestamp: 5, content: 155 }

-- forecast5 is superseded: its path now has a concrete value
-- forecast6 re-derives using month 5 actual (155) as new baseline
-- forecast7 re-derives using the updated chain
```

The re-anchoring is automatic. The historical entry at timestamp 5 supersedes the forecast for that period. Because forecast6 references the model which references the data, adding the actual data point triggers re-derivation of the model parameters and all downstream forecasts. Concreteness at the actual data point jumps to 1.0; downstream forecasts recompute from the stronger baseline.

## Interpolation Policy Selection

Different data series use different forecasting methods. The policy is assigned per path:

```ft
InterpolationPolicy = {
  method: "linear" | "exponential" | "seasonal",
  decayFactor: number 0..1
}

-- Series A uses linear
seriesA = RegressionModel
seriesA << { method: "linear" }

-- Series B uses exponential
seriesB = RegressionModel
seriesB << { method: "exponential" }

policy seriesA: { method: "linear", decayFactor: "0.65" }
policy seriesB: { method: "exponential", decayFactor: "0.55" }
```

The policy determines both the regression method and the concreteness decay rate. Linear extrapolation degrades more slowly than exponential for the same step count. Changing the policy recomputes all forecasts for that series.

## Capabilities

The historical data that feeds the model is externally provided. The interpolation policy is a user choice:

```ft
tool RegressionModel.dataPoints
tool InterpolationPolicy.method
tool InterpolationPolicy.decayFactor
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Regression derives slope from historical data | `salesModel << { method: "linear", dataPoints: ref(monthlySales) }` |
| Forecast generated from model parameters | `forecast5 << { step: 1, basedOn: ref(salesModel) }` |
| Concreteness degrades with forecast horizon | step 1 > step 2 > step 3 via multiplicative decay factor |
| Actual data replaces forecast and reanchors | `monthlySales.entries.month5 << { content: 155 }` supersedes forecast5 |
| Interpolation policy selectable per series | `policy seriesA: { method: "linear" }` vs `policy seriesB: { method: "exponential" }` |
| Fit quality readable as metric | `fitQuality: number 0..1` in RegressionModel |
