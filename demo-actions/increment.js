// Increment action for the Statebox example
const main = (params = {}) => {
  const input = params.value ? params.value : 0;
  const increment = params.increment ? params.increment : 1;
  return { value: input + increment };
};

module.exports.main = main;
