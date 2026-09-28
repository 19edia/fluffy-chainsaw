import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {Events} from 'discord.js';
import {boot,reporter} from '../src/preflight.js';
import {initialize} from '../src/db.js';
import {createBot} from '../src/bot.js';
import {createApp} from '../src/app.js';
import {ID_FIELDS} from '../src/config-rules.js';

async function fixture(t,mode){
 const db=new PGlite();await db.waitReady;t.after(()=>db.close());const logs=[],events=[];
 const env={NODE_ENV:'test',APP_ORIGIN:'http://localhost:3000',BOT_ENABLED:'true',DATABASE_URL:'postgresql://test:PRIVATE_DATABASE_PASSWORD@localhost/test',SESSION_SECRET:'PRIVATE_SESSION_SECRET'.repeat(3),DISCORD_TOKEN:'PRIVATE_DISCORD_TOKEN_FOR_TEST_ONLY',INITIAL_ADMIN_USERNAME:'admin',INITIAL_ADMIN_PASSWORD:'PRIVATE_ADMIN_PASSWORD'};
 let id=10000000000000000n;for(const n of [1,2])for(const suffix of ID_FIELDS)env[`DIV_${n}_${suffix}`]=String(++id);
 const pool={query:async(input,args)=>{
  const {text,values}=typeof input==='string'?{text:input,values:args}:input;
  if(mode==='schema-timeout'&&text.startsWith('CREATE TABLE'))throw Object.assign(new Error('PRIVATE_DATABASE_PASSWORD'),{code:'57014'});
  const r=values?await db.query(text,values):(await db.exec(text)).at(-1);return {...r,rowCount:r.affectedRows||r.rows.length};
 },connect:async()=>({...pool,release(){}}),end:async()=>events.push('pool-end')};
 let bot,server;
 t.mock.method(console,'info',(...args)=>logs.push(args.join(' ')));
 const options={env,makePool:()=>pool,initialize,makeApp:createApp,log:reporter(line=>logs.push(line)),
  makeBot:(pool,config)=>{
   events.push('make-bot');bot=createBot(pool,config);let ready=false;
   bot.client.isReady=()=>ready;bot.client.login=async()=>{events.push('gateway');if(mode==='gateway-intents')throw new Error('Used disallowed intents');ready=true;bot.client.emit(Events.ClientReady,bot.client);return env.DISCORD_TOKEN;};
   // External guild/channel permissions and publication have their own suites.
   bot.validate=async()=>{assert.ok(bot.ready());events.push('validated');};
   bot.activate=()=>{assert.ok(server?.listening);events.push('activated');};
   return bot;
  },listen:async app=>{events.push('listen');server=app.listen(0,'127.0.0.1');await once(server,'listening');return server;}};
 t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));if(bot)await bot.stop();});
 return {options,events,logs,db,server:()=>server};
}

test('complete startup migrates a real SQL database, creates admin, connects the Client and serves ready',async t=>{
 const f=await fixture(t,'success');const running=await boot(f.options);
 assert.deepEqual(f.events,['make-bot','gateway','validated','listen','activated']);
 const response=await fetch(`http://127.0.0.1:${running.server.address().port}/ready`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ready'});
 assert.equal((await f.db.query('SELECT username,role FROM staff')).rows[0].role,'admin');
 assert.match(f.logs.join('\n'),/\[INICIALIZAÇÃO\]\[PRONTO\]/);assert.doesNotMatch(f.logs.join('\n'),/PRIVATE_/);
});

test('schema cancellation names the migration and rolls back before Discord or HTTP can start',async t=>{
 const f=await fixture(t,'schema-timeout');await assert.rejects(boot(f.options),/tabelas e índices básicos.*57014/);
 assert.deepEqual(f.events,['pool-end']);assert.equal(f.server(),undefined);
 assert.equal((await f.db.query("SELECT to_regclass('public.staff') AS staff")).rows[0].staff,null);
 assert.doesNotMatch(f.logs.join('\n'),/PRIVATE_|\[PRONTO\]/);
});

test('a real Client intent failure remains distinct from database success and never opens HTTP',async t=>{
 const f=await fixture(t,'gateway-intents');await assert.rejects(boot(f.options),/Server Members Intent/);
 assert.deepEqual(f.events,['make-bot','gateway','pool-end']);assert.equal(f.server(),undefined);
 assert.equal((await f.db.query('SELECT role FROM staff')).rows[0].role,'admin');
 assert.match(f.logs.join('\n'),/atualização concluída/);assert.doesNotMatch(f.logs.join('\n'),/PRIVATE_|\[PRONTO\]/);
});
