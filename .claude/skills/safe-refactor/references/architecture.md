# Architecture catalog: coupling and patterns

Architecture refactors have the biggest payoff and the biggest blast radius. The project's existing architecture (stated in docs, or evident from consistent structure) is the reference. Fix deviations from it before proposing a different one; proposing a new architecture is out of scope for a refactor unless the user asked.

## Contents

1. Tight coupling
2. Incorrectly applied patterns
3. Patterns worth applying (and when not to)
4. Measuring structural improvement

---

## 1. Tight coupling

**Signals**

- Layer violations: UI importing a DB client or HTTP client directly; domain logic importing framework objects (request/response, React, ORM models).
- Deep imports into another feature's internals (`../../billing/internal/calc`), bypassing its public entry point.
- Circular dependencies (madge/dependency-cruiser report them).
- Hub modules with high fan-in _and_ high fan-out (everything imports them, and they import everything) — usually a `utils` or `helpers` grab-bag.
- Module-level singletons with mutable state read from many places.
- Concrete classes constructed inside the code that uses them (`new StripeClient()` inside business logic), making substitution and testing impossible.
- Components coupled to the exact shape of a global store.
- Inheritance used for code reuse rather than "is-a" (base classes full of helpers).

**Fixes**

- Depend on an interface or function type at boundaries; inject the concrete implementation (constructor parameter, function parameter, React context, or the project's DI mechanism).
- Give each feature a public entry point (`index.ts`) and route cross-feature imports through it.
- Break cycles by extracting the shared piece into a lower-level module, or by inverting one dependency.
- Split grab-bag `utils` by domain and move each function next to its main consumers.
- Selector functions between components and store shape.
- Composition over inheritance.

**Behavior traps**

- **Sync → async.** Replacing a direct call with an event or message bus usually makes it asynchronous. Ordering, error propagation, and transaction boundaries change. Keep it synchronous unless the user approves the change.
- **Module initialization order.** Breaking a cycle or moving code changes when module-level code runs. Watch for registration side effects.
- **Singleton identity.** Turning a singleton into injected instances can create multiple instances where code relied on one shared cache or connection pool. Inject the same instance.

## 2. Incorrectly applied patterns

| Pattern misuse                    | Signal                                                                               | Typical correction                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Singleton as global mutable state | `getInstance()` everywhere, state mutated from many modules, tests reset it          | Explicit instance passed in; keep one instance at the composition root                              |
| Factory that makes one thing      | `createX()` always returns the same class                                            | Inline (speculative generality)                                                                     |
| Strategy via flags                | One function with `mode` param and `switch` inside, called with literals             | Separate functions, or real strategies if variants are many                                         |
| Observer/event emitter leaks      | Subscriptions without unsubscribe; listeners added in render/effects without cleanup | Return and call disposers. **Note:** fixing a leak changes behavior (handlers stop firing). Log it. |
| Global store for local UI state   | Modal open flags, form drafts, hover state in Redux/global store                     | Local component state. Check devtools/persistence/analytics consumers first.                        |
| Context as a global store         | One giant context, every consumer re-renders on any change                           | Split contexts by update frequency, or use the project's store                                      |
| Service locator                   | `container.get('x')` scattered through logic                                         | Constructor/parameter injection                                                                     |
| Middle-man layers                 | Service → manager → repository, each just forwarding                                 | Collapse layers that add nothing                                                                    |
| Repository leaking ORM            | Repository returns ORM entities or query builders                                    | Return domain types; keep ORM inside                                                                |
| Logic in controllers/components   | Business rules inside route handlers or JSX components                               | Extract into domain functions/services the handler calls                                            |
| Deep inheritance                  | Hierarchies more than 2 levels, overrides calling `super` in tricky orders           | Composition, delegation                                                                             |
| HOC chains (React)                | `withA(withB(withC(Component)))` for logic reuse                                     | Custom hooks, if the project uses hooks elsewhere                                                   |
| Anemic abstraction                | Interface mirrors one class 1:1 and nothing else implements it                       | Remove the interface                                                                                |

## 3. Patterns worth applying (and when not to)

Apply a pattern only when the pain it solves **already exists in the code**: two or more concrete variants today, a conditional repeated at several sites, or changes that already require shotgun surgery. A pattern added for hypothetical future variants is speculative generality.

| Pattern                             | Apply when                                                                       | Don't when                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Lookup table / map                  | A `switch`/`if` chain maps keys to values or handlers                            | Branches have different shapes of logic                     |
| Strategy / polymorphism             | The same type discriminator is switched on in 2+ places                          | Only one switch site exists                                 |
| State machine / discriminated union | Boolean soup (`isLoading`, `isError`, `data`) with invalid combinations possible | The flags are truly independent                             |
| Adapter                             | A third-party API is called directly from many places with repeated glue         | One call site                                               |
| Facade                              | Callers orchestrate the same sequence of subsystem calls repeatedly              | The sequence varies per caller                              |
| Pipeline / composition              | Data passes through a fixed sequence of transforms, written as one long function | The steps share lots of intermediate state                  |
| Builder / options object            | Construction requires many optional parameters, often in invalid combinations    | 3 or fewer parameters                                       |
| Command                             | Actions need undo/redo, queuing, or logging                                      | Plain function calls suffice                                |
| Dependency injection                | A unit can't be tested without module mocking or network                         | The dependency is pure and cheap (e.g. a formatting helper) |

**State machine trap:** if the current code can actually reach a combination like `isLoading && isError` (even briefly), and anything renders differently in that state, collapsing to a union removes that state. Pin all reachable combinations in baseline tests before deciding; if one is reachable and observable, the change needs approval.

## 4. Measuring structural improvement

Record before/after for the report:

- Circular dependency count (madge `--circular`)
- Layer/boundary rule violations (dependency-cruiser with a temporary config in `.refactor/`)
- Fan-in/fan-out of the worst hub modules
- Number of files touched by a typical change (from git history, before only, as motivation)
- Count of `instanceof`/type-switch sites replaced
