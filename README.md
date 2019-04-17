State Machines with Continuations, running on Apache OpenWhisk
===

This [Apache OpenWhisk](http://openwhisk.apache.org) Action executes state machines defined using the 
[Amazon States Language](https://states-language.net/spec.html), using
the [statebox](https://github.com/wmfs/statebox) library.

A _Suspend_ task allows the current execution to be suspended, with its
state stored in Redis. 

A _continuation ID_ is returned when that happens,
allowing the state machine to be restarted.

The continuation stores the state machine definition and the current context
values. 

State _Tasks_ however, call other OpenWhisk Actions, so modifying those actions while a state machine is suspended will impact its execution when restarted.

This is just a proof of concept for now, many things would need to be improved - my
goal was just to get a feel for how this can work and what the limitations of such
an approach are.

Implementing a continuations mechanism for the [OpenWhisk Composer](https://github.com/apache/incubator-openwhisk-composer) would also make sense, either in addition to or instead of this.
I started with [statebox](https://github.com/wmfs/statebox) for this prototype as I'm not familiar
with the composer code and wanted to play with state machines - but the mechanisms would be similar.

State Machine Definitions
----
The [state-machines](./state-machines) folder has a few examples, here's an example state that calls an 
OpenWhisk action:

    "A": {
        "Type": "Task",
        "InputPath": "$.values",
        "ResultPath": "$.values.value",
        "Resource": "module:increment",
        "Next": "B"
    }

And here's the code of the [`increment` action](demo-actions/increment.js) that it calls:

    const main = (params = {}) => {
        const input = params.value ? params.value : 0;
        const increment = params.increment ? params.increment : 1;
        return { value: input + increment };
    };

The semantics are simple in this basic example: the action takes a `value` parameter and
returns an object that includes its new value.

To suspend the state machine, the `module:Suspend` resource is used:

    "Suspend": {
        "Type": "Task",
        "Resource": "module:suspend",
        "Next": "C"
    }

How to test this
----

You'll need a Redis service that your OpenWhisk Actions can access. In a pinch you can run one locally and make it
accessible using [ngrok](https://ngrok.com/). Make sure you understand the security implications if you do this.

You'll also need a working
_wsk_ command, see [openwhisk.apache.org](http://openwhisk.apache.org) if you're not familiar with that.

The below examples require the REDIS_HOST and REDIS_PORT environment variables to be set.

To run the [incsquare](state-machines/incsquare.json) example, install the _increment_ and _square_
Actions that it uses:

    wsk action update increment demo-actions/increment.js
    wsk action update square demo-actions/square.js

And install the main action as follows:

    npm install
    rm -rf action.zip
    zip -r action.zip package.json *.js state-machines lib node_modules
    wsk -i action update statebox action.zip --web true \
        --param host $REDIS_HOST --param port $REDIS_PORT --kind nodejs:10

You can then get the action's URL:

    export URL=$(wsk -i action get statebox --url | grep http)

And call it as in this example, providing a state machine definition and
an input value:

    curl \
        -X POST \
        -H "Content-Type: application/json" \
        -d @state-machines/incsquare.json \
        -L \
        "$URL?input=6"

The above example uses the `incsquare` demo state machine which increments and squares
 the input value, suspends execution and returns the current state values along with
 a continuation ID:

    {
        "CONTINUATION": "3e08ff74-cd0d-4710-8213-1495f00ba4e6",
        "constants": {
            "redis_host": "redis.example.com",
            "redis_port": 12930,
            "version": "1.12"
        },
        "values": {
            "value": 49
        }
    }

Which you can pass to the action to restart execution:

    export K=<the continuation ID that you got>
    curl -XPOST -L "$URL?continuation=$K"

Which finishes that state machine's execution and returns the final result:

    {
        "constants": {
            "redis_host": "redis.example.com",
            "redis_port": 12930,
            "restartedFrom": "3e08ff74-cd0d-4710-8213-1495f00ba4e6",
            "version": "1.12"
        },
        "values": {
            "value": 50
        }
    }

Continuations have a default lifetime of 300 seconds and error handling
is still minimal.    

To see what happened you can use `wsk activation list`, `wsk activation logs` etc. - see
the [wsk documentation](https://github.com/apache/incubator-openwhisk/blob/master/docs/cli.md#openwhisk-cli)
for more info.

What's next
---
The [Amazon States Language](https://states-language.net/spec.html) spec includes _Parallel_ tasks which will
probably cause problems with this basic implementation, in case only one branch is suspended. Not tested so far.

Only single input values are supported for now, the code will need to be adapted to support JSON objects as 
input values.

So far it's not possible to provide additional input when restarting suspended state machines, some logic should
be added to merge additional values when doing that. A common use case is to suspend a state machine after 
requesting human input, which will need to be merged with the current execution data.





