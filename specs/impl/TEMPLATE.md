# [Title]

[1-2 paragraph prose: what this is, why it matters, what makes it hard.]

## [First concept — the core type/pattern]

[Prose explaining the concept, then the ft block defining it:]

```ft
TypeName = [
  capability1 = (input: Type) -> { output: Type 
    | behavioral_predicate  @[T_out..termination)  ~survival(exp, rate) }
  
  capability2 = (input: Type) -> { output: Type }

  "Documentation interleaved with definitions"

  ref("./dependency")
]
```

[Prose explaining what the ft block means and why each predicate matters.]

## [Second concept — usage/instantiation]

[Prose, then ft block:]

```ft
instance = TypeName
instance << { constructor_field: "value" }
cap instance.capability1
```

[Prose explaining instantiation pattern.]

## [Additional concepts as needed]

[More prose + ft blocks, interleaved.]

## What This Validates

[Table mapping acceptance criteria to the ft blocks above:]

| AC | Expressed by |
|----|-------------|
| Description of criterion | Which ft construct/pattern covers it |
