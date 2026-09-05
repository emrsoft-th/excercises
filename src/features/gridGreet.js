'use strict';

const { register } = require('../registry');

register(
  'gridGreet',
  {
    description: 'Says hello to whoever is passed in.',
    author: 'starter-kit',
    addedIn: 'v0.1.0',
  },
  (who = 'world') => `Hello, ${who}!`
);
