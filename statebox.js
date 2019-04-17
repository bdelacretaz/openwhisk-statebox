/* eslint-disable no-console */
// Execute suspendable state machines on OpenWhisk,
// using https://github.com/wmfs/statebox
//
// Statebox uses the Amazon States Langage,
// see https://states-language.net/spec.html
//
const Statebox = require('@wmfs/statebox');
const uuidv4 = require('uuid/v4');
const openwhisk = require('openwhisk');
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

// State machine definition
// TODO should be provided as input to this function
function defaultStateMachine() {
  return {
    incsquare: {
      Comment: 'Increment and square a value',
      StartAt: 'A',
      States: {
        A: {
          Type: 'Task',
          InputPath: '$.values',
          ResultPath: '$.values.value',
          Resource: 'module:increment',
          Next: 'B',
        },
        B: {
          Type: 'Task',
          InputPath: '$.values',
          ResultPath: '$.values.value',
          Resource: 'module:square',
          Next: 'Suspend',
        },
        Suspend: {
          Type: 'Task',
          Resource: 'module:suspend',
          Next: 'C',
        },
        C: {
          Type: 'Task',
          InputPath: '$.values',
          ResultPath: '$.values.value',
          Resource: 'module:increment',
          Next: 'SendResponse',
        },
        SendResponse: {
          Type: 'Task',
          Resource: 'module:sendResponse',
          End: true,
        },
      },
    },
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
      const result = await store.get(key);
      console.log(`\nCONTINUATION DATA for #${result.key}, loaded from store as ${result.data}`);
      console.log(JSON.stringify(result.data, null, 2));

      // Not calling context.sendTaskSuccess stops the state machine
      // TODO is there a better way?
      event.success(event);
    }
  },
  sendResponse: class SendResponse {
    // eslint-disable-next-line class-methods-use-this
    run(event /* context */) {
      console.log('RES:sendResponse');
      const successEvent = event;
      successEvent.elapsedMsec = new Date() - event.startTime;
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
      console.log(`OW_ACTION ${name} returns ${JSON.stringify(output, null, 2)}`);
      context.sendTaskSuccess(output.value);
    }
  };
}

// Return our module resources for statebox
async function getModuleResources() {
  // Start with our default resources
  const resources = BUILTIN_RESOURCES;

  // Add available OpenWhisk actions
  // TODO we might only add those that are used in
  // the state machine that's about to run
  (await openwhisk().actions.list()).forEach((decl) => {
    console.log(`Registering OW action ${decl.name} for statebox`);
    resources[decl.name] = createOWResource(decl.name);
  });

  return resources;
}

// OpenWhisk action code
const main = (params = {}) => {
  const input = { values: {}, redis: {} };
  input.startTime = new Date();
  input.redis.host = params.host ? params.host : 'localhost';
  input.redis.port = params.port ? params.port : 6379;

  const result = new Promise(async (resolve, reject) => {
    store = new StateStore({ host: input.redis.host, port: input.redis.port });

    // Create module resources and run state machine
    await statebox.ready;
    await statebox.createModuleResources(await getModuleResources());

    // Select the state machine
    if (params.continuation && params.continuation.length > 0) {
      console.log(`Restarting from continuation ${params.continuation}`);
      const data = await store.get(params.continuation);
      if (!data.data) reject(new Error(`Continuation not found or expired: ${params.continuation}`));
      console.log(`CONTINUE FROM ${JSON.stringify(data, null, 2)}`);
      input.stateMachine = data.data.stateMachine;
      input.values = data.data.data.values;
    } else {
      input.values.value = params.input ? parseInt(params.input, 10) : 1;
      input.stateMachine = defaultStateMachine();
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
        start: input.values.input,
        startTime: input.startTime,
        host: input.redis.host,
        port: input.redis.port,
      },
      values: input.values,
      success: (data) => {
        console.log('RESPONSE:');
        console.log(data);
        resolve({ body: data });
      }
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
    console.log('Closing StateStore');
    await store.close();
  });

  return result;
};

if (require.main === module) {
  main({
    input: process.argv[2],
    continuation: process.argv[3],
    host: process.argv[4],
    port: process.argv[5],
  });
}

module.exports.main = main;
