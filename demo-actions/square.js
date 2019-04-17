// Square action for the Statebox example
const main = (params = {}) => {
  const input = params.value ? params.value : 0;
  return { value: input * input };
};

module.exports.main = main;
