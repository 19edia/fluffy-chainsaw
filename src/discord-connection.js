import {Events,version} from 'discord.js';
import {StartupError} from './preflight.js';

export const DISCORD_CONNECT_TIMEOUT_MS=90000;
export const STARTUP_TIMEOUT_MS=180000;
const fatalCodes={
 '4004':'Token do bot recusado pelo Discord. Atualize DISCORD_TOKEN em Environment no Render com o token de Bot dessa aplicação.',
 'TokenInvalid':'Token do bot recusado pelo Discord. Atualize DISCORD_TOKEN em Environment no Render com o token de Bot dessa aplicação.',
 '401':'Token do bot recusado pelo Discord. Atualize DISCORD_TOKEN em Environment no Render com o token de Bot dessa aplicação.',
 '4010':'O Discord recusou a configuração de shards. Revise a configuração da aplicação.',
 '4011':'O Discord exige sharding para esta aplicação. Revise a configuração do bot.',
 '4012':'O Discord recusou a versão do Gateway. Publique package.json e package-lock.json e use npm ci no build.',
 '4013':'O Discord recusou os intents solicitados pelo bot. Confira a versão das dependências e a configuração dos intents.',
 '4014':'Ative Server Members Intent em Discord Developer Portal → Bot → Privileged Gateway Intents, salve e publique novamente.'
};
const knownErrors={
 ENOTFOUND:'Falha de DNS ao localizar o Discord.',EAI_AGAIN:'DNS temporariamente indisponível ao localizar o Discord.',
 ECONNREFUSED:'A conexão ao Discord foi recusada.',ECONNRESET:'A conexão ao Discord foi interrompida.',
 ETIMEDOUT:'A conexão de rede ao Discord expirou.',ENETUNREACH:'Não há rota de rede para o Discord.',
 UND_ERR_CONNECT_TIMEOUT:'A conexão HTTPS ao Discord expirou.',UND_ERR_HEADERS_TIMEOUT:'A API do Discord não respondeu aos cabeçalhos a tempo.',
 DEPTH_ZERO_SELF_SIGNED_CERT:'A conexão TLS com o Discord foi recusada por certificado inválido.',
 UNABLE_TO_VERIFY_LEAF_SIGNATURE:'Não foi possível validar o certificado TLS do Discord.',
 DisallowedIntents:fatalCodes['4014'],InvalidIntents:fatalCodes['4013']
};
function errorCode(error){
 // @discordjs/ws emits plain Errors for these fatal Gateway failures.
 // Never echo arbitrary messages: they can contain URLs or authorization data.
 if(error?.message==='Used disallowed intents')return '4014';
 if(error?.message==='Used invalid intents')return '4013';
 if(error?.message==='Authentication failed')return '4004';
 if(error?.message==='Invalid shard')return '4010';
 if(error?.message==='Sharding is required')return '4011';
 if(error?.message==='Used an invalid API version')return '4012';
 // REST can report {code: 0, status: 401}; an unrecognized API code must
 // not hide the HTTP authentication status or a recognized network cause.
 for(const value of [error?.code,error?.cause?.code,error?.status,error?.cause?.status]){
  const code=String(value);
  if(Object.hasOwn(fatalCodes,code)||Object.hasOwn(knownErrors,code))return code;
 }
 return 'UNKNOWN';
}

export function connectDiscord(client,token,{timeoutMs=DISCORD_CONNECT_TIMEOUT_MS,log=line=>console.info(line)}={}){
 if(client.isReady())return Promise.resolve();
 return new Promise((resolve,reject)=>{
  let settled=false,timeout,poll,progress,phase='consultando API e abrindo conexão Gateway',lastProblem='';
  const started=Date.now(),subscriptions=[];
  const emit=message=>{try{log(`[DISCORD][CONEXÃO] ${message}`);}catch{/* A log transport must not break the connection. */}};
  const subscribe=(target,event,fn)=>{if(target?.on){target.on(event,fn);subscriptions.push([target,event,fn]);}};
  function finish(error){
   if(settled)return;settled=true;clearTimeout(timeout);clearInterval(poll);clearInterval(progress);
   for(const [target,event,fn]of subscriptions)target.off(event,fn);
   if(error)reject(error);else{emit(`Pronto para receber eventos. Tempo: ${Date.now()-started} ms.`);resolve();}
  }
  function checkReady(){if(!settled&&client.isReady())finish();}
  function failFrom(error){
   const code=errorCode(error);
   finish(new StartupError(`Discord: ${fatalCodes[code]||knownErrors[code]||'Falha ao iniciar a conexão. Confira o estado da API/Gateway e as variáveis do serviço no Render.'}`));
  }
  subscribe(client,Events.ClientReady,checkReady);
  subscribe(client,Events.ShardReady,()=>{phase='sessão autenticada; carregando servidores';emit('Gateway autenticado; aguardando o cliente ficar pronto.');checkReady();});
  subscribe(client,Events.ShardReconnecting,()=>{phase='reconectando ao Gateway';emit('Conexão interrompida; aguardando a reconexão automática.');});
  subscribe(client,Events.ShardResume,checkReady);
  subscribe(client,Events.ShardDisconnect,event=>{
   const code=String(event?.code);
   if(Object.hasOwn(fatalCodes,code)){failFrom({code});return;}
   lastProblem='A conexão Gateway foi encerrada antes de ficar pronta.';
   phase='aguardando reconexão automática';
   emit(`Conexão encerrada${Number.isInteger(event?.code)?` (código ${event.code})`:''}. Aguardando nova tentativa da biblioteca.`);
  });
  const onError=error=>{
   const code=errorCode(error);
   if(Object.hasOwn(fatalCodes,code)||['DisallowedIntents','InvalidIntents'].includes(code)){failFrom(error);return;}
   lastProblem=knownErrors[code]||'Falha de transporte durante a conexão com o Discord.';
   emit(lastProblem);
  };
  subscribe(client,Events.ShardError,onError);
  subscribe(client,Events.Error,onError);
  subscribe(client.rest,'rateLimited',data=>{
   const delay=Number(data?.retryAfter);
   phase='aguardando limite de requisições da API do Discord';
   lastProblem='A API do Discord está limitando requisições. Evite reinícios repetidos ou várias instâncias com o mesmo token.';
   emit(lastProblem+(Number.isFinite(delay)&&delay>=0?` Nova tentativa da biblioteca em cerca de ${Math.ceil(delay/1000)} s.`:''));
  });
  emit(`Iniciando com discord.js ${version}; prazo máximo de ${Math.ceil(timeoutMs/1000)} s.`);
  poll=setInterval(checkReady,Math.max(1,Math.min(250,Math.floor(timeoutMs/4))));
  progress=setInterval(()=>emit(`Aguardando: ${phase}. Decorridos ${Math.floor((Date.now()-started)/1000)} s.`),15000);
  timeout=setTimeout(()=>{
   checkReady();if(settled)return;
   finish(new StartupError(`Discord não ficou pronto em ${Math.ceil(timeoutMs/1000)} segundos. Etapa: ${phase}. ${lastProblem||'A API ou o Gateway não concluíram a conexão; esse tempo limite não confirma que o token está errado.'} Confira os registros [DISCORD][CONEXÃO] acima.`));
  },timeoutMs);
  // login() resolving does not guarantee all guilds are ready. Conversely, a ready
  // client must not time out merely because an event name changed across versions.
  try{Promise.resolve(client.login(token)).then(checkReady,error=>{if(!settled)failFrom(error);});}
  catch(error){failFrom(error);}
 });
}
