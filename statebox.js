// Execute suspendable state machines on OpenWhisk,
// using https://github.com/wmfs/statebox
//
// Statebox uses the Amazon States Langage,
// see https://states-language.net/spec.html
//
/* eslint-disable no-console */

const Statebox = require('@wmfs/statebox');
const uuidv4 = require('uuid/v4');
const openwhisk = require('openwhisk');
const demoStateMachine = require('./examples/incsquare.json');
const StateStore = require('./state-store.js');

const statebox = new Statebox({});

let store;
const EXPIRATION_SECONDS = 300;
const VERSION = '1.12';

// Get suspend data, what must be saved
// to restart the state machine after suspending
function getSuspendData(event, inputContext) {
  const context = inputContext;
  context.task.stateMachine.definition.StartAt = context.task.definition.Next;
  const machine = {};
  machine[context.task.stateMachine.name] = context.task.stateMachine.definition;
  return {
    data: event,
    restartAt: context.task.definition.Next,
    stateMachine: machine,
  };
}

// We need a few builtin statebox "resources"
// to suspend state machines, send responses etc.
const BUILTIN_RESOURCES = {
  suspend: class Suspend {
    // eslint-disable-next-line class-methods-use-this
    async run(event, context) {
      console.log('RES:Suspending state machine');
      const suspendData = getSuspendData(event, context);
      const key = await store.put(suspendData, EXPIRATION_SECONDS);
      const successEvent = event;
      successEvent.CONTINUATION = key;

      // Not calling context.sendTaskSuccess stops the state machine
      // TODO is there a better way?
      event.success(event);
    }
  },
  sendResponse: class SendResponse {
    // eslint-disable-next-line class-methods-use-this
    run(event) {
      console.log('RES:sendResponse');
      const successEvent = event;
      event.success(successEvent);
    }
  },
};

// Creates a statebox "resource" (executor class)
// which wraps an OpenWhisk Action
function createOWResource(name) {
  return class {
    // eslint-disable-next-line class-methods-use-this
    async run(event, context) {
      const ow = openwhisk();
      const output = await ow.actions.invoke(
        {
          name,
          blocking: true,
          result: true,
          params: event,
        },
      );
      console.log(`RES:Action ${name} returns ${JSON.stringify(output, null, 2)}`);
      context.sendTaskSuccess(output.value);
    }
  };
}

// Return our module resources for statebox,
// including available OpenWhisk actions
async function getModuleResources() {
  // Start with our default resources
  const resources = BUILTIN_RESOURCES;

  // Add available OpenWhisk actions
  // TODO we might only add those that are used in
  // the state machine that's about to run
  const actions = [];
  (await openwhisk().actions.list()).forEach((decl) => {
    actions.push(decl.name);
    resources[decl.name] = createOWResource(decl.name);
  });
  console.log(`OpenWhisk actions registered for statebox: ${actions}`);

  return resources;
}

// OpenWhisk action code
const main = (params = {}) => {
  const input = { values: {}, redis: {} };
  input.redis.host = params.host ? params.host : 'localhost';
  input.redis.port = params.port ? params.port : 6379;

  const result = new Promise(async (resolve, reject) => {
    const expect = 'post';
    // eslint-disable-next-line no-underscore-dangle
    if (params.__ow_method !== expect) {
      // eslint-disable-next-line no-underscore-dangle
      const out = { status: 405, body: `Expected ${expect} method, got ${params.__ow_method}` };
      console.log(out);
      reject(out);
      return;
    }

    store = new StateStore({ host: input.redis.host, port: input.redis.port });

    // Create module resources and run state machine
    await statebox.ready;
    await statebox.createModuleResources(await getModuleResources());

    // Select the state machine
    if (params.continuation && params.continuation.length > 1) {
      console.log(`Restarting from continuation ${params.continuation}`);
      const data = await store.get(params.continuation);
      if (!data.data) {
        reject(new Error(`Continuation not found or expired: ${params.continuation}`));
        return;
      }
      input.stateMachine = data.data.stateMachine;
      input.values = data.data.data.values;
    } else {
      input.values.value = params.input ? parseInt(params.input, 10) : 1;
      if (params.statemachine) {
        input.stateMachine = params.statemachine;
      } else {
        console.log('No state machine definition provided, using demo state machine');
        input.stateMachine = demoStateMachine.statemachine;
      }
    }

    // Use a unique state machine name for each run
    const m2 = {};
    m2[`M-${uuidv4()}`] = input.stateMachine[Object.keys(input.stateMachine)[0]];
    input.stateMachine = m2;

    const stateMachineName = Object.keys(input.stateMachine)[0];
    console.log(`Creating state machine ${stateMachineName}`);
    await statebox.createStateMachines(input.stateMachine, {});

    const stateMachineInput = {
      constants: {
        version: VERSION,
        redis_host: input.redis.host,
        redis_port: input.redis.port,
      },
      values: input.values,
      success: (data) => {
        console.log('RESPONSE:');
        console.log(data);
        resolve({ body: data });
      },
    };

    if (params.continuation) {
      stateMachineInput.constants.restartedFrom = params.continuation;
    }

    console.log(`Starting state machine ${stateMachineName}`);

    try {
      statebox.startExecution(stateMachineInput, stateMachineName, {});
    } catch (e) {
      reject(e);
    }
  });

  result.finally(async () => {
    if (store) {
      console.log('Closing StateStore');
      await store.close();
    }
  });

  return result;
};

if (require.main === module) {
  main({
    input: process.argv[2],
    continuation: process.argv[3],
    host: process.argv[4],
    port: process.argv[5],
    __ow_method: 'post',
    __ow_body: process.argv[7],
  });
}

module.exports.main = main;
