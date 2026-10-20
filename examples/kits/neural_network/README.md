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

This is new code written for Manimator. It copies the look of those videos but none of their code.
