/**
 * One shared, frozen empty array for "the query hasn't resolved yet".
 *
 * The idiom this exists to fix:
 *
 *     const { data: customers = [] } = useQuery({ ... })
 *
 * While the query is in flight `data` is undefined, so the default `[]` is
 * re-evaluated on every render and hands back a **new array identity each
 * time**. That is invisible until the binding is listed in a hook's dependency
 * array. Then:
 *
 *     useEffect(() => { ...setSomething(...) }, [customers, ...])
 *
 * new identity → effect fires → setState → render → new identity, round and
 * round, until the data lands and React Query starts returning one stable
 * reference. React gives up after 50 nested updates and logs "Maximum update
 * depth exceeded". The page still paints correctly, which is exactly why this
 * survived on three pages for as long as it did — it is a burst of wasted
 * renders on every load, not a hang.
 *
 * The same trap applies to `?? []` and `|| []` fallbacks assigned at render
 * scope. Use this constant for all of them:
 *
 *     const { data: customers = EMPTY_ARRAY } = useQuery({ ... })
 *     const products = pageData?.products ?? EMPTY_ARRAY
 *
 * A dependency array is the only place the identity matters, but using it
 * everywhere is cheaper than auditing which bindings a future hook will list.
 *
 * Frozen so that mutating the shared placeholder throws in strict mode instead
 * of silently poisoning every other consumer. Callers that need to sort or push
 * must copy first (`[...items]`), which they already do.
 *
 * Typed loosely on purpose: a `readonly never[]` would not be assignable to the
 * `Foo[]` these bindings are declared as, and the point is to be a drop-in
 * replacement for the `[]` literal it replaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EMPTY_ARRAY: any[] = Object.freeze([]) as unknown as any[]
