# Feed forward

Plays on a **Neural network** (the Neural network customization): the network lights up layer by layer, left to
right, the way a network runs. Each layer's neurons fill to how active they are, while a pulse runs along the edges
into that layer. The neurons stay lit at the end; the edges go back to how they were.

- **Pattern** picks which neurons light up and how much. It is the same pattern as the network's own **Light up**
  setting: play Feed forward with Pattern 7 on a network that isn't lit, and it ends looking like the network with
  Light up on and Pattern 7.
- **Pulse color** and **Pulse width** (times the edge width) style the pulse.

The animation starts each neuron from how lit it already is, so playing it again with another pattern moves the
network from one pattern to the other. On anything other than a Neural network it does nothing.
