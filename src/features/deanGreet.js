'use strict';

const { register } = require('../registry');

register(
  'deanGreet',
  {
    description: 'Says hello to whoever is passed in.',
    author: 'starter-kit',
    addedIn: 'v0.1.1',
  },
  (who = 'world') => `Hello, ${who}!`
);
