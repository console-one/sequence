# Interpolations

## Original Notes

Interpolations here are interesting because they are going to be forecasts that we electively choose as policies for time-based contract understanding of how things in a particular functions partition may work or could be assumed to work in some future, given that we don't know them. We are using historicals here to just generate a library of general regression tools or whatever that would be applied for planned futures at specific type join lattice locations.

Statistical forecasting: learning patterns from historical data and projecting them forward to fill unknown future values, with explicit uncertainty tracking. Forecasts are useful but inherently uncertain -- the system must produce estimates that are actionable while never pretending they are facts. Uncertainty compounds naturally: a forecast 3 months out is less reliable than one 1 month out, and this degradation must be visible and quantifiable.

The same interpolation framework works across different domains (financial, operational, temporal) without domain-specific hardcoding. The interpolation method (linear, exponential, seasonal) is a policy selected per path or partition, not a global setting.

## Problem Context

- **Actor(s)**: Users who select interpolation policies and consume forecast outputs; the regression engine that fits models and generates projections; the data pipeline that supplies historical inputs.
- **Domain**: Statistical forecasting -- fitting regression models to historical data and projecting values forward with explicit, compounding uncertainty.
- **Core Tension**: Forecasts must be actionable (produce concrete numbers) while being honest about their uncertainty. Farther-out forecasts are inherently less reliable, and this degradation must be visible -- not hidden behind a single point estimate.

## Requirements

**R1**: The system SHALL fit a regression model to a historical data series and derive trend parameters (slope, intercept, or method-specific equivalents) automatically.
- *Rationale*: Users should not need to manually compute regression coefficients. The system derives them from data and updates them when data changes.
- *Verifiable by*: Given a series of historical data points, the system produces slope and intercept values consistent with the selected regression method.

**R2**: The system SHALL report a fit quality metric (e.g., R-squared) for each model, indicating how well the chosen method matches the historical data.
- *Rationale*: A forecast from a poorly-fitting model is less trustworthy. Users need to see whether their chosen method is appropriate.
- *Verifiable by*: A model fitted to perfectly linear data with the "linear" method reports fit quality near 1.0; a model fitted to seasonal data with "linear" reports a lower fit quality.

**R3**: The system SHALL generate forecasts by projecting forward from the last known data point using the fitted model parameters.
- *Rationale*: Forecasts fill unknown future values based on observed trends, enabling planning and scheduling.
- *Verifiable by*: Given a linear model with known slope and intercept, a forecast at step N returns a value consistent with `lastKnown + slope * N`.

**R4**: Forecast confidence SHALL degrade with increasing distance from the last known data point, and this degradation SHALL be quantifiable per forecast step.
- *Rationale*: A 1-month-out forecast is more reliable than a 6-month-out forecast. The system must never present a far-horizon estimate with the same confidence as a near-horizon one.
- *Verifiable by*: For steps 1, 2, 3 of the same model, the reported confidence is strictly decreasing: confidence(step 1) > confidence(step 2) > confidence(step 3).

**R5**: When actual data arrives for a previously forecasted period, the forecast for that period SHALL be replaced by the actual value, and all downstream forecasts SHALL recompute from the new baseline.
- *Rationale*: Actuals supersede estimates. Downstream forecasts should re-anchor to the latest real data to avoid compounding errors from an outdated baseline.
- *Verifiable by*: After recording an actual value at step 5, the forecast for step 5 is replaced, the model re-fits with the new data point, and forecasts for steps 6+ are recalculated.

**R6**: Interpolation method (linear, exponential, seasonal) SHALL be selectable per data series, not globally.
- *Rationale*: Different data series have different characteristics. Revenue might be linear, seasonal demand might be sinusoidal. A global method would produce poor fits for most series.
- *Verifiable by*: Series A is configured with "linear" and Series B with "exponential"; each produces forecasts using its respective method.

**R7**: Changing the interpolation policy for a series SHALL recompute all forecasts for that series using the new method.
- *Rationale*: Policy changes should take effect immediately and consistently, not leave stale forecasts computed under the old method.
- *Verifiable by*: Switching Series A from "linear" to "exponential" causes all its forecast values to change to reflect exponential projection.

**R8**: Model parameters SHALL automatically re-derive when new historical data points are added to the underlying series.
- *Rationale*: The model should always reflect the latest available data without manual re-fitting.
- *Verifiable by*: Adding a new historical entry causes the model's slope, intercept, and fit quality to update.

**R9**: The confidence decay rate SHALL be configurable per series and SHALL reflect the model's fit quality.
- *Rationale*: A well-fitting model (high R-squared) should decay more slowly than a poorly-fitting one, because its projections are more trustworthy.
- *Verifiable by*: Two models at the same forecast step but different fit qualities report different confidence levels; the better-fitting model has higher confidence.

## Acceptance Criteria

**AC1** [R1, R2]: Given monthly sales data [100, 110, 120, 130] and method "linear", when the model is fitted, then slope is approximately 10, intercept is approximately 90, and fit quality is near 1.0.

**AC2** [R3, R4]: Given the fitted linear model from AC1, when forecasts are generated for steps 1, 2, and 3, then step 1 returns approximately 140, step 2 approximately 150, step 3 approximately 160, with strictly decreasing confidence across steps.

**AC3** [R5]: Given forecasts at steps 1-3, when an actual value of 155 is recorded for step 1, then the step 1 forecast is replaced by 155, the model re-fits including the new data point, and steps 2-3 produce updated values anchored to the new baseline.

**AC4** [R6, R7]: Given Series A using "linear" and Series B using "exponential", when Series A's method is switched to "seasonal", then only Series A's forecasts change; Series B is unaffected.

**AC5** [R8]: Given a fitted model, when a new historical data point is appended, then slope, intercept, and fit quality are automatically updated without user intervention.

**AC6** [R9]: Given a model with fit quality 0.95 and another with fit quality 0.60, when both produce a forecast at step 3, then the 0.95 model reports higher confidence than the 0.60 model at that step.

## Open Questions

- What specific regression algorithms are required at launch (least-squares, exponential smoothing, Holt-Winters, etc.), and can users add custom methods?
- How should the system handle structural breaks in historical data (e.g., a sudden regime change that invalidates prior trend)?
- Should forecast confidence be reported as a single scalar, a confidence interval (e.g., 80%/95% bands), or both?
