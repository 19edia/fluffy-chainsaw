import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {inspect} from 'node:util';
import {Events} from 'discord.js';
import {StartupError} from '../src/preflight.js';
import {connectDiscord} from '../src/discord-connection.js';
import {createBot} from '../src/bot.js';

const secret='PRIVATE_DISCORD_TOKEN_NEVER_LOG';
const watched=[Events.ClientReady,Events.Error,Events.ShardError,Events.ShardDisconnect,Events.ShardReconnecting,Events.ShardReady,Events.ShardResume,Events.Invalidated,Events.Debug];
function fixture(){
 const client=new EventEmitter(),logs=[],loginTokens=[];let ready=false,resolveLogin,rejectLogin,destroyed=0;
 const loginPromise=new Promise((resolve,reject)=>{resolveLogin=resolve;rejectLogin=reject;});
 client.rest=new EventEmitter();
 client.isReady=()=>ready;client.login=token=>{loginTokens.push(token);return loginPromise;};client.destroy=async()=>{destroyed++;};
 const existingErrorListener=()=>{};client.on(Events.Error,existingErrorListener);
 const baseline=new Map(watched.map(event=>[event,client.listeners(event)]));
 return {client,logs,loginTokens,resolveLogin,rejectLogin,ready:()=>{ready=true;},destroyed:()=>destroyed,
  connect:(timeoutMs=50)=>connectDiscord(client,secret,{timeoutMs,log:(...messages)=>logs.push(messages.map(value=>typeof value==='string'?value:inspect(value)).join(' '))}),
  assertClean:()=>{for(const event of watched)assert.deepEqual(client.listeners(event),baseline.get(event),`listeners leaked for ${event}`);assert.equal(client.rest.listenerCount('rateLimited'),0);},
  assertSafe:error=>{assert.ok(!logs.join('\n').includes(secret));assert.ok(!String(error?.message??'').includes(secret));}
 };
}

test('an already ready client resolves without starting a second login or removing application listeners',async()=>{
 const f=fixture();f.ready();await f.connect();assert.equal(f.loginTokens.length,0);f.assertClean();f.assertSafe();
});

test('the installed Discord ClientReady event resolves even while login promise is still pending',async()=>{
 const f=fixture();const pending=f.connect();assert.deepEqual(f.loginTokens,[secret]);assert.ok(f.client.listenerCount(Events.ClientReady)>0);f.ready();f.client.emit(Events.ClientReady,f.client);await pending;f.assertClean();f.assertSafe();
 // A later login result must not reinstall listeners or leak the returned token.
 f.resolveLogin(secret);await Promise.resolve();f.assertClean();f.assertSafe();
});

test('login resolving its token does not complete startup before the client is ready',async()=>{
 const f=fixture();let completed=false;const pending=f.connect().then(()=>{completed=true;});f.resolveLogin(secret);await delay(5);assert.equal(completed,false);f.ready();f.client.emit(Events.ClientReady,f.client);await pending;assert.equal(completed,true);f.assertClean();f.assertSafe();
});

test('isReady immediately after login resolves recovers a missing ready event',async()=>{
 const f=fixture();const pending=f.connect();f.ready();f.resolveLogin(secret);await pending;f.assertClean();f.assertSafe();
});

test('polling or the final timeout readiness check recovers ready state without a ready event',async()=>{
 const f=fixture();const pending=f.connect(40);f.resolveLogin(secret);await delay(5);f.ready();await pending;f.assertClean();f.assertSafe();
});

test('transient shard disconnects and reconnections keep waiting and can recover successfully',async()=>{
 const f=fixture();let completed=false;const pending=f.connect().then(()=>{completed=true;});f.resolveLogin(secret);
 f.client.emit(Events.ShardDisconnect,{code:1006,reason:secret},0);f.client.emit(Events.ShardReconnecting,0);f.client.emit(Events.ShardError,Object.assign(new Error(secret),{code:'ECONNRESET'}),0);f.client.emit(Events.Debug,`Authorization: Bot ${secret}`);await delay(5);assert.equal(completed,false);
 f.ready();f.client.emit(Events.ClientReady,f.client);await pending;f.assertClean();f.assertSafe();
});

test('invalid login token rejects with a safe startup error and cleans temporary listeners',async()=>{
 const f=fixture();const pending=f.connect();f.rejectLogin(Object.assign(new Error(`Invalid token ${secret}`),{code:'TokenInvalid'}));let error;
 await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,/token/i);return true;});f.assertClean();f.assertSafe(error);
});

test('definitive gateway authentication and intent failures reject promptly with safe actionable errors',async()=>{
 for(const [code,pattern]of [[4004,/token|autentica/i],[4013,/intent/i],[4014,/intent/i]]){
  const f=fixture();const pending=f.connect();f.client.emit(Events.ShardDisconnect,{code,reason:secret},0);let error;
  await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,pattern);return true;});f.assertClean();f.assertSafe(error);
 }
});

test('DisallowedIntents from the login promise is translated to a safe startup error',async()=>{
 const f=fixture();const pending=f.connect();f.rejectLogin(Object.assign(new Error(secret),{code:'DisallowedIntents'}));let error;
 await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,/intent/i);return true;});f.assertClean();f.assertSafe(error);
});

test('REST code zero does not hide HTTP 401 or leak the raw response',async()=>{
 const f=fixture();const pending=f.connect();f.rejectLogin(Object.assign(new Error(secret),{code:0,status:401,url:`https://example.invalid/${secret}`}));let error;
 await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,/Token do bot recusado/);return true;});f.assertClean();f.assertSafe(error);
});

test('timeout reports the last connection stage without exposing raw gateway details',async()=>{
 const f=fixture();const pending=f.connect(25);f.resolveLogin(secret);await Promise.resolve();f.client.emit(Events.ShardDisconnect,{code:1006,reason:secret},0);f.client.emit(Events.ShardReconnecting,0);let error;
 await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,/Etapa:.*reconect/i);return true;});f.assertClean();f.assertSafe(error);
 const logs=f.logs.length;f.client.emit(Events.ShardDisconnect,{code:1006,reason:secret},0);f.client.emit(Events.ShardReconnecting,0);await delay(35);assert.equal(f.logs.length,logs);f.assertClean();
});

test('a synchronous login failure is handled safely and releases startup listeners',async()=>{
 const f=fixture();f.client.login=()=>{throw Object.assign(new Error(secret),{code:'TokenInvalid'});};let error;
 await assert.rejects(f.connect(),value=>{error=value;assert.ok(value instanceof StartupError);return true;});f.assertClean();f.assertSafe(error);
});

test('a rejected login promise arriving after readiness does not become an unhandled rejection',async()=>{
 const f=fixture();const pending=f.connect();f.ready();f.client.emit(Events.ClientReady,f.client);await pending;f.rejectLogin(Object.assign(new Error(secret),{code:'ECONNRESET'}));await delay(5);f.assertClean();f.assertSafe();
});

test('plain fatal errors from discordjs ws are recognized without relying on an error code',async()=>{
 for(const [message,pattern]of [['Used disallowed intents',/intent/i],['Used invalid intents',/intent/i],['Authentication failed',/token/i],['Invalid shard',/shard/i],['Sharding is required',/sharding/i],['Used an invalid API version',/versão|Gateway/i]]){
  const f=fixture();const pending=f.connect();f.client.emit(Events.ShardError,new Error(message),0);
  await assert.rejects(pending,value=>value instanceof StartupError&&pattern.test(value.message));f.assertClean();
 }
});

test('REST rate limits preserve a safe last stage and release the temporary REST listener',async()=>{
 const f=fixture();const pending=f.connect(25);f.client.rest.emit('rateLimited',{retryAfter:10000,url:`https://example.invalid/${secret}`,route:secret,global:true});let error;
 await assert.rejects(pending,value=>{error=value;assert.ok(value instanceof StartupError);assert.match(value.message,/limite de requisições/);return true;});f.assertClean();f.assertSafe(error);assert.match(f.logs.join('\n'),/10 s/);
});

test('successful connection clears deadline and progress timers',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture();const pending=f.connect(90000);f.ready();f.client.emit(Events.ClientReady,f.client);await pending;const logs=f.logs.length;t.mock.timers.tick(180000);assert.equal(f.logs.length,logs);f.assertClean();
});

test('a Gateway becoming ready after the old 35-second deadline can now finish startup',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture();let finished=false;const pending=connectDiscord(f.client,secret,{log:line=>f.logs.push(line)}).then(()=>{finished=true;});
 f.resolveLogin(secret);await Promise.resolve();t.mock.timers.tick(40000);await Promise.resolve();assert.equal(finished,false);
 f.ready();f.client.emit(Events.ClientReady,f.client);await pending;assert.equal(finished,true);f.assertClean();f.assertSafe();
});

function integrationBot(t,botEnabled=true){
 const pool={query:()=>assert.fail('Startup must not query the database or activate the worker'),connect:()=>assert.fail('Startup must not start a database transaction')};
 const bot=createBot(pool,{botEnabled,token:secret,divisions:[]});t.after(async()=>{await bot.stop();});
 return bot;
}

test('createBot.start resolves on ClientReady before the real Client login promise completes',async t=>{
 const logs=[];t.mock.method(console,'info',(...args)=>logs.push(args.join(' ')));
 const bot=integrationBot(t);let ready=false,resolveLogin,loginCalls=0;
 bot.client.isReady=()=>ready;bot.client.login=token=>{loginCalls++;assert.equal(token,secret);return new Promise(resolve=>{resolveLogin=resolve;});};
 const pending=bot.start();assert.equal(loginCalls,1);ready=true;bot.client.emit(Events.ClientReady,bot.client);await pending;assert.equal(bot.ready(),true);assert.equal(bot.client.listenerCount(Events.ClientReady),0);
 resolveLogin(secret);await Promise.resolve();assert.ok(!logs.join('\n').includes(secret));
});

test('createBot.start translates Client login rejection to a safe StartupError',async t=>{
 const logs=[];t.mock.method(console,'info',(...args)=>logs.push(args.join(' ')));
 const bot=integrationBot(t);bot.client.isReady=()=>false;bot.client.login=async()=>{throw Object.assign(new Error(`Bad token ${secret}`),{code:'TokenInvalid'});};
 await assert.rejects(bot.start(),error=>{assert.ok(error instanceof StartupError);assert.match(error.message,/token/i);assert.ok(!error.message.includes(secret));return true;});assert.equal(bot.client.listenerCount(Events.ClientReady),0);assert.ok(!logs.join('\n').includes(secret));
});

test('BOT_ENABLED=false skips Client login without activating background work',async t=>{
 const bot=integrationBot(t,false);let logins=0;bot.client.isReady=()=>false;bot.client.login=async()=>{logins++;throw new Error('Login must be skipped');};
 await bot.start();assert.equal(logins,0);assert.equal(bot.client.listenerCount(Events.ClientReady),0);
});
