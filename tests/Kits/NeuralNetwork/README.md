# Neural network

A neural network diagram in the style of 3Blue1Brown's 2017 neural network videos: blue neurons in columns,
grey edges joining every neuron to every neuron in the next layer.

- **Layers**: neurons in each layer, left to right, like `784, 16, 16, 10` (up to 12 layers).
- **Most shown**: a bigger layer shows this many neurons around a vertical ellipsis. **Size braces** adds a
  brace beside it with the layer's real size.
- **Output labels** numbers the last layer's neurons, as in the digit-recognition video.
- **Light up** fills the neurons by random amounts, as if the network had just seen an input. **Pattern** picks
  a different random pattern.

Neuron size, spacing, colors and line widths can all be changed. The defaults are the ones used in the videos.

## Animations

- **Feed forward**: the network lights up layer by layer, left to right, the way a network runs. Each layer's
  neurons fill to how active they are, while a pulse runs along the edges into that layer. The neurons stay lit at
  the end; the edges go back to how they were.
  - **Pattern** picks which neurons light up and how much. It is the same pattern as the network's own **Light up**
    setting: play Feed forward with Pattern 7 on a network that isn't lit, and it ends looking like the network
    with Light up on and Pattern 7.
  - **Pulse color** and **Pulse width** (times the edge width) style the pulse.

  It starts each neuron from how lit it already is, so playing it again with another pattern moves the network
  from one pattern to the other.

This is new code written for Manimator. It copies the look of those videos but none of their code.
