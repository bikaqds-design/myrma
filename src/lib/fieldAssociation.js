import React from 'react'

/**
 * associateFieldId — wire a <label> to the control it labels.
 *
 * Field wrappers render the label and the control as siblings, so there is no
 * implicit association, and every one of them needed an explicit htmlFor/id
 * pair that nobody was writing. Rather than ask each of the ~35 call sites to
 * invent an id, the wrapper generates one with useId() and this clones it onto
 * the control.
 *
 * It takes the first *element* child, not the only child, because plenty of
 * fields carry a hint paragraph or a scale row alongside the input — the
 * Pipeline stage select and probability slider both do, and requiring a lone
 * child silently skipped exactly those.
 *
 * It does NOT try to work out which child is "really" a form control. The
 * obvious version of that check — match the component name against input /
 * select / textarea — was written, and it failed: Vite renames the inner
 * function of `React.forwardRef(function Input(...))` to `Input2` to avoid
 * colliding with the exported const, so nothing matched, and a production
 * build would have minified the name away entirely. Any name-based test is
 * wrong for the same reason. Taking the first element is boring and holds.
 *
 * A caller that sets its own id keeps it. When there is no element child at
 * all, htmlFor comes back undefined: a label pointing at an id that does not
 * exist is worse than a label pointing at nothing.
 */
export function associateFieldId(children, generatedId) {
  const kids = React.Children.toArray(children)
  const target = kids.find((k) => React.isValidElement(k))
  if (!target) return { htmlFor: undefined, children }
  if (target.props.id) return { htmlFor: target.props.id, children }
  return {
    htmlFor: generatedId,
    children: kids.map((k) =>
      k === target ? React.cloneElement(k, { id: generatedId }) : k
    ),
  }
}
