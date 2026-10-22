# Refraction

Light passing from one medium into another, worked out with the real optics: it bends by Snell's law,
n₁ sin(θ₁) = n₂ sin(θ₂), and part of it is reflected, as the Fresnel equations say. The light hits the boundary at
the object's center, and every ray runs to the edges of the media, so moving the object moves the whole picture.

- **Top index** and **Bottom index**: the refractive index n of each medium, such as 1 for air or a vacuum, 1.333
  for water, 1.5 for glass and 2.42 for diamond.
- **Light comes from**: the medium the light starts in, the top or the bottom.
- **Incoming angle**: the angle between the incoming light and the normal line. Below 0 the light comes in from the
  right.
- The bent angle follows from those. Light going into a higher index bends towards the normal, into a lower one away
  from it.
- **Partial reflection**: some light always bounces back off the boundary, at the same angle as it came in. Each ray
  is drawn as bright as the share of the light it carries (unpolarized light; the brightness is corrected for the
  screen's gamma of 2.2). At small angles little is reflected; towards 90 degrees most of it is.
- Going into a lower index past the critical angle, none of the light gets through: it is all reflected (total
  internal reflection), and the other medium's arc and label are left out.
- **Normal line**, **Angle arcs** and **Labels** can each be turned off. The labels name the angle in each medium
  (LaTeX) and show each medium's index in its corner.
- Width, depth, colors and line widths can all be changed. The top medium is see-through until you raise its
  opacity.

Its parts, in order: top medium, bottom medium, normal line, incoming ray, bent ray, reflected ray, top arc, bottom
arc, top label, bottom label, top index, bottom index. A part that is turned off, or can't be there (the bent ray
past the critical angle), is an empty group, so the order never changes.

## Animations

- **Shine** brings the refraction in: the media and the normal fade in, then the light travels in to the boundary
  and on, bent and reflected. Each angle's arc and label appear as the light reaches it.
- **Sweep angle** turns the incoming light to **To angle**, starting from the angle it has. The bent and reflected
  rays, the arcs and the labels follow it, so you can watch θ₂ and the reflection change with θ₁, or the light stop
  getting through past the critical angle. Play it again to sweep on from there. It works wherever the refraction was
  moved, turned or scaled to.
