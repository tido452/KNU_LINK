/* KNU LINK — browser client. No frameworks, analytics, tracking or external APIs. */
'use strict';
const el = id => document.getElementById(id);
const MODE_LABELS = {friend:'친구 만들기',date:'설레는 만남',random:'랜덤 토크',connect:'인맥 · 팀원'};
const state = {
  ws:null, reconnect:null, connected:false, stage:'entry',
  mode:'friend', interests:new Set(), name:'', adultConfirmed:false,
  partner:null, initiator:false, matchId:null,
  localStream:null, localVideoTrack:null, pc:null, remoteStream:null,
  audioReady:false, peerAudioReady:false, cameraMine:false, cameraPeer:false,
  makingOffer:false, pendingNegotiation:false, iceBuffer:[], friendRequested:false, friendMatched:false,
  callStart:null, callTimer:null, timedNotice:false, stats:{online:0,queues:{}}
};
const $ = (selector, root=document) => root.querySelector(selector);
function notice(message,error=false){
  const box=document.createElement('div');box.className='toast'+(error?' error':'');box.textContent=message;el('toast-region').append(box);
  window.setTimeout(()=>box.remove(),4600);
}
function send(type,detail={}){
  if(!state.ws||state.ws.readyState!==WebSocket.OPEN){notice('서버가 연결되지 않았어요. 잠시 후 다시 시도해 주세요.',true);return false;}
  state.ws.send(JSON.stringify({type,...detail}));return true;
}
function setScreen(which){
  state.stage=which;
  ['entry','matching','call'].forEach(x=>el(x+'-screen').classList.toggle('hidden',x!==which));
}
function updateStats(){
  el('online-count').textContent=state.stats.online??0;
  el('queue-count').textContent=state.stats.queues?.[state.mode]??0;
}
function connect(){
  clearTimeout(state.reconnect);
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(`${proto}//${location.host}/ws`);
  state.ws=socket;
  socket.addEventListener('open',()=>{
    state.connected=true;
    const status=el('server-status');status.classList.remove('offline');status.classList.add('online');
    $('span',status).textContent='매칭 서버 연결됨';
  });
  socket.addEventListener('message',async e=>{
    let m;try{m=JSON.parse(e.data);}catch{return;}
    try{await onServerMessage(m);}catch(err){console.error('client message error:',err);notice('요청을 처리하는 중 오류가 발생했어요.',true);}
  });
  socket.addEventListener('close',()=>{
    state.connected=false;
    const status=el('server-status');status.classList.remove('online');status.classList.add('offline');
    $('span',status).textContent='서버 재연결 중';
    if(state.stage!=='entry'){stopMedia();setScreen('entry');notice('서버 연결이 끊어졌어요. 다시 매칭해 주세요.',true);}
    state.reconnect=setTimeout(connect,1800);
  });
  socket.addEventListener('error',()=>{});
}
async function onServerMessage(m){
  switch(m.type){
    case 'hello':break;
    case 'stats':state.stats=m;updateStats();break;
    case 'searching':setScreen('matching');updateStats();break;
    case 'paired':
      stopMedia();state.partner=m.partner;state.matchId=m.matchId;state.initiator=!!m.initiator;
      state.friendRequested=false;state.friendMatched=false;
      el('friend-button').textContent='♡ 친구 신청';el('friend-button').classList.remove('active');el('friend-button').disabled=false;
      initCallScreen();setScreen('call');notice('새로운 사람과 연결됐어요!');break;
    case 'idle':stopMedia();setScreen('entry');break;
    case 'peer-left':
      stopMedia();setScreen('entry');notice(m.message||'상대방이 연결을 종료했어요.');break;
    case 'blocked':stopMedia();setScreen('entry');notice(m.message);break;
    case 'reported':stopMedia();setScreen('entry');notice(m.message);break;
    case 'chat':appendChat(m.message,false,m.sentAt);break;
    case 'audio-status':
      state.audioReady=!!m.mine;state.peerAudioReady=!!m.peer;refreshMediaButtons();
      if(state.audioReady && state.peerAudioReady){setCallStatus('마이크 연결 중…');if(state.initiator){await getOrCreatePeer();} }
      else setCallStatus(state.audioReady?'상대방의 음성 연결 동의를 기다리는 중…':'상대방이 음성 연결을 요청했어요. 마이크를 연결해 보세요.');
      break;
    case 'camera-status':
      state.cameraMine=!!m.mine;state.cameraPeer=!!m.peer;
      await syncVideoConsent();refreshMediaButtons();break;
    case 'signal':await onSignal(m.signal);break;
    case 'friend-pending':
      state.friendRequested=true;el('friend-button').textContent='♡ 수락 대기 중';el('friend-button').classList.add('active');break;
    case 'friend-requested':
      if(!state.friendRequested)notice('상대방이 친구 신청을 보냈어요. 마음이 맞으면 수락하세요!');break;
    case 'friend-match':
      state.friendMatched=true;el('friend-button').textContent='♥ 서로 친구가 됐어요';el('friend-button').disabled=true;
      appendSystem('서로 친구 신청에 동의했어요! 이 데모에서는 통화 종료 후 친구 재연결 기능이 아직 없어요.');
      notice('서로 친구 신청이 성립했어요!');break;
    case 'error':notice(m.message||'오류가 발생했어요.',true);break;
    default:break;
  }
}
function initCallScreen(){
  const p=state.partner;
  el('matched-mode-label').textContent=MODE_LABELS[state.mode];
  el('call-subtitle').textContent=`${p.name}님과 연결되었어요. 3분 동안 가볍게 대화해 보세요.`;
  el('remote-display-name').textContent=p.name;
  el('remote-name-tag').textContent=p.name;
  el('partner-name').textContent=p.name;
  el('partner-tags').textContent=p.interests?.length?p.interests.join(' · '):'새로운 만남';
  el('remote-avatar').textContent=(p.name||'?')[0];el('partner-initial').textContent=(p.name||'?')[0];
  el('chat-messages').replaceChildren();
  appendSystem('매칭되었습니다. 서로를 존중하며 대화해 주세요.');
  if(p.interests?.length && state.interests.size){
    const common=p.interests.filter(x=>state.interests.has(x));
    if(common.length)appendSystem('공통 관심사: '+common.join(', '));
  }
  state.callStart=Date.now();state.timedNotice=false;clearInterval(state.callTimer);
  function tick(){
    if(!state.callStart)return;
    const seconds=Math.floor((Date.now()-state.callStart)/1000);
    el('session-timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
    if(seconds>=180&&!state.timedNotice){state.timedNotice=true;appendSystem('3분이 지났어요. 더 대화하거나 친구를 신청할 수 있어요.');}
  }
  tick();state.callTimer=setInterval(tick,1000);
  refreshMediaButtons();setCallStatus('채팅을 먼저 시작하거나, 서로 마이크 연결에 동의하세요.');
  el('chat-input').focus();
}
function appendChat(text,mine=false,sentAt){
  const container=el('chat-messages');
  const bubble=document.createElement('div');bubble.className='chat-bubble'+(mine?' mine':'');
  const msg=document.createElement('div');msg.className='bubble-text';msg.textContent=text;
  const time=document.createElement('small');
  const date=sentAt?new Date(sentAt):new Date();time.textContent=date.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  bubble.append(msg,time);container.append(bubble);container.scrollTop=container.scrollHeight;
}
function appendSystem(text){const node=document.createElement('div');node.className='chat-system';node.textContent=text;el('chat-messages').append(node);el('chat-messages').scrollTop=el('chat-messages').scrollHeight;}
function setCallStatus(message,active=false){el('call-message').textContent=message;el('call-indicator').classList.toggle('indicator-active',active);}
function refreshMediaButtons(){
  const a=el('audio-button'),v=el('camera-button');
  a.textContent=state.audioReady?'◉ 마이크 연결됨':'◉ 음성 연결';a.classList.toggle('active',state.audioReady);a.disabled=state.audioReady;
  v.textContent=state.cameraMine?'▣ 카메라 동의 취소':'▣ 카메라 동의';v.classList.toggle('active',state.cameraMine);v.disabled=!(state.audioReady && state.peerAudioReady);
  // Camera access is only requested after both people explicitly consent.
}
function resetVideo(){
  el('local-video').pause();el('remote-video').pause();
  el('local-video').srcObject=null;el('remote-video').srcObject=null;
  el('local-video').classList.remove('visible');el('remote-video').classList.remove('visible');
  el('local-placeholder').classList.remove('hidden');el('remote-placeholder').classList.remove('hidden');
}
function stopMedia(){
  clearInterval(state.callTimer);state.callTimer=null;state.callStart=null;
  if(state.pc){state.pc.onnegotiationneeded=null;state.pc.close();state.pc=null;}
  if(state.localStream){state.localStream.getTracks().forEach(t=>t.stop());state.localStream=null;}
  if(state.localVideoTrack){state.localVideoTrack.stop();state.localVideoTrack=null;}
  state.remoteStream=null;state.audioReady=false;state.peerAudioReady=false;
  state.cameraMine=false;state.cameraPeer=false;state.iceBuffer=[];state.makingOffer=false;state.pendingNegotiation=false;
  state.partner=null;state.matchId=null;resetVideo();refreshMediaButtons();
}
async function startAudio(){
  if(state.stage!=='call'||state.audioReady)return;
  if(!navigator.mediaDevices?.getUserMedia){notice('마이크 사용에는 localhost 또는 HTTPS 연결이 필요합니다.',true);return;}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(state.stage!=='call'){stream.getTracks().forEach(x=>x.stop());return;}
    state.localStream=stream;state.audioReady=true;refreshMediaButtons();
    setCallStatus('상대방의 마이크 동의를 기다리는 중…');
    send('audio-ready');
  }catch(err){notice('마이크 권한이 필요해요. 브라우저 설정을 확인해 주세요. ('+err.name+')',true);}
}
function createConfig(){return {iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};}
async function getOrCreatePeer(){
  if(state.pc)return state.pc;
  if(!state.audioReady||!state.localStream)throw new Error('microphone not ready');
  const pc=new RTCPeerConnection(createConfig());state.pc=pc;state.remoteStream=new MediaStream();
  el('remote-video').srcObject=state.remoteStream;
  for(const track of state.localStream.getAudioTracks())pc.addTrack(track,state.localStream);
  if(state.localVideoTrack)pc.addTrack(state.localVideoTrack,state.localStream);
  pc.onicecandidate=event=>{if(event.candidate)send('signal',{signal:{kind:'candidate',candidate:event.candidate.toJSON()}});};
  pc.ontrack=event=>{
    if(state.pc!==pc)return;
    const stream=state.remoteStream;
    if(!stream.getTracks().some(t=>t.id===event.track.id))stream.addTrack(event.track);
    event.track.onunmute=()=>updateVideoElements();event.track.onmute=()=>updateVideoElements();
    updateVideoElements();
    el('remote-video').play().catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{
    if(state.pc!==pc)return;
    if(pc.connectionState==='connected')setCallStatus('실시간 통화 연결됨',true);
    else if(pc.connectionState==='failed')setCallStatus('통화 연결에 실패했어요. 다른 네트워크 또는 TURN 서버가 필요할 수 있어요.');
    else if(pc.connectionState==='disconnected')setCallStatus('통화 연결이 잠시 끊어졌어요.');
  };
  pc.onsignalingstatechange=()=>{if(pc.signalingState==='stable'&&state.pendingNegotiation&&state.initiator){state.pendingNegotiation=false;negotiate();}};
  pc.onnegotiationneeded=async()=>{
    if(state.initiator){await negotiate();}
    else if(state.pc===pc){send('signal',{signal:{kind:'renegotiate'}});}
  };
  return pc;
}
async function negotiate(){
  const pc=state.pc;
  if(!pc||!state.initiator||state.stage!=='call')return;
  if(state.makingOffer||pc.signalingState!=='stable'){state.pendingNegotiation=true;return;}
  state.makingOffer=true;
  try{
    await pc.setLocalDescription(await pc.createOffer());
    if(state.pc===pc)send('signal',{signal:{kind:'offer',sdp:pc.localDescription.toJSON()}});
  }catch(err){console.error('negotiate',err);notice('통화 협상 오류가 발생했어요.',true);}
  finally{state.makingOffer=false;}
}
async function flushIce(){
  if(!state.pc?.remoteDescription)return;
  while(state.iceBuffer.length){
    const candidate=state.iceBuffer.shift();
    try{await state.pc.addIceCandidate(candidate);}catch(err){console.warn('ICE candidate failed',err);}
  }
}
async function onSignal(signal){
  if(!signal||state.stage!=='call')return;
  if(signal.kind==='renegotiate'){
    if(state.initiator&&state.pc){await negotiate();}
    return;
  }
  if(signal.kind==='candidate'){
    if(!signal.candidate)return;
    if(!state.pc?.remoteDescription){state.iceBuffer.push(signal.candidate);}else{
      try{await state.pc.addIceCandidate(signal.candidate);}catch(err){console.warn('ICE failure',err);}
    }
    return;
  }
  if(signal.kind==='offer'){
    const pc=await getOrCreatePeer();
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    await flushIce();
    await pc.setLocalDescription(await pc.createAnswer());
    send('signal',{signal:{kind:'answer',sdp:pc.localDescription.toJSON()}});
  }else if(signal.kind==='answer'){
    if(!state.pc)return;
    await state.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    await flushIce();
    if(state.pendingNegotiation){state.pendingNegotiation=false;await negotiate();}
  }
}
async function syncVideoConsent(){
  if(state.stage!=='call')return;
  const both=state.cameraMine&&state.cameraPeer;
  if(!both){
    if(state.localVideoTrack){
      const track=state.localVideoTrack;state.localVideoTrack=null;
      if(state.pc){const sender=state.pc.getSenders().find(s=>s.track===track);if(sender)state.pc.removeTrack(sender);}
      track.stop();if(state.localStream)state.localStream.removeTrack(track);
    }
    updateVideoElements();
    if(state.cameraMine&&!state.cameraPeer)notice('상대방이 카메라에 동의하면 영상이 켜져요.');
    return;
  }
  if(state.localVideoTrack){updateVideoElements();return;}
  if(!navigator.mediaDevices?.getUserMedia){notice('카메라는 localhost 또는 HTTPS 연결에서 사용 가능합니다.',true);send('camera-intent',{enabled:false});return;}
  try{
    const capture=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:720}},audio:false});
    if(state.stage!=='call'||!state.cameraMine||!state.cameraPeer){capture.getTracks().forEach(t=>t.stop());return;}
    const track=capture.getVideoTracks()[0];state.localVideoTrack=track;
    track.onended=()=>{if(state.localVideoTrack===track)send('camera-intent',{enabled:false});};
    if(!state.localStream)state.localStream=new MediaStream();state.localStream.addTrack(track);
    if(state.pc)state.pc.addTrack(track,state.localStream);
    updateVideoElements();
  }catch(err){notice('카메라 접근이 거부되었어요. 음성·텍스트 대화는 계속할 수 있어요.',true);send('camera-intent',{enabled:false});}
}
function updateVideoElements(){
  const localOn=!!state.localVideoTrack&&state.cameraMine&&state.cameraPeer;
  const remoteTrack=state.remoteStream?.getVideoTracks()?.[0];
  const remoteOn=!!remoteTrack&&remoteTrack.readyState==='live'&&!remoteTrack.muted&&state.cameraMine&&state.cameraPeer;
  const lv=el('local-video'),rv=el('remote-video');
  if(localOn){
    if(lv.srcObject!==state.localStream)lv.srcObject=state.localStream;
    lv.play().catch(()=>{});
  }
  lv.classList.toggle('visible',localOn);el('local-placeholder').classList.toggle('hidden',localOn);
  rv.classList.toggle('visible',remoteOn);el('remote-placeholder').classList.toggle('hidden',remoteOn);
  el('remote-media-text').textContent=state.cameraMine&&!state.cameraPeer?'상대방의 영상 동의를 기다리는 중':state.audioReady&&state.peerAudioReady?'음성 통화 중':'음성 통화에 연결해 보세요';
}
async function cameraClick(){
  if(state.stage!=='call')return;
  send('camera-intent',{enabled:!state.cameraMine});
}
function initiateSearch(){
  const name=el('nickname').value.trim();
  if(name.length<2){notice('닉네임을 2글자 이상 입력해 주세요.',true);el('nickname').focus();return;}
  const adultConfirmed=el('adult-consent').checked;
  if(state.mode==='date'&&!adultConfirmed){notice('성인 확인 동의 후 소개팅 모드를 이용할 수 있어요.',true);return;}
  if(!state.connected){notice('매칭 서버 연결을 확인해 주세요.',true);return;}
  state.name=name;state.adultConfirmed=adultConfirmed;
  try{localStorage.setItem('knu-link-nickname',name);}catch{}
  if(send('search',{mode:state.mode,name,interests:[...state.interests],adultConfirmed})){
    el('search-mode').textContent=MODE_LABELS[state.mode];setScreen('matching');
  }
}
function init(){
  try{el('nickname').value=localStorage.getItem('knu-link-nickname')||'';}catch{}
  document.querySelectorAll('.mode-card').forEach(button=>{
    button.addEventListener('click',()=>{
      state.mode=button.dataset.mode;
      document.querySelectorAll('.mode-card').forEach(c=>{const on=c===button;c.classList.toggle('selected',on);c.setAttribute('aria-pressed',String(on));});
      el('adult-consent-row').classList.toggle('hidden',state.mode!=='date');
    });
  });
  document.querySelectorAll('.interest').forEach(button=>{
    button.addEventListener('click',()=>{
      const value=button.dataset.interest;
      if(state.interests.has(value))state.interests.delete(value);
      else if(state.interests.size<5)state.interests.add(value);
      else return notice('관심사는 최대 5개까지 선택할 수 있어요.');
      button.classList.toggle('chosen',state.interests.has(value));
    });
  });
  el('start-button').addEventListener('click',initiateSearch);
  el('nickname').addEventListener('keydown',e=>{if(e.key==='Enter')initiateSearch();});
  el('cancel-button').addEventListener('click',()=>send('cancel'));
  el('leave-button').addEventListener('click',()=>send('cancel'));
  el('next-button').addEventListener('click',()=>{
    stopMedia();el('search-mode').textContent=MODE_LABELS[state.mode];setScreen('matching');
    send('next',{adultConfirmed:state.adultConfirmed});
  });
  el('chat-form').addEventListener('submit',e=>{
    e.preventDefault();const input=el('chat-input'),value=input.value.trim();
    if(value&&send('chat',{message:value})){appendChat(value,true);input.value='';}
  });
  el('audio-button').addEventListener('click',startAudio);
  el('camera-button').addEventListener('click',cameraClick);
  el('friend-button').addEventListener('click',()=>{if(!state.friendRequested&&!state.friendMatched)send('friend-request');});
  el('block-button').addEventListener('click',()=>{if(confirm('상대방을 차단하고 연결을 종료할까요?'))send('block');});
  el('report-button').addEventListener('click',()=>el('report-dialog').showModal());
  el('report-cancel').addEventListener('click',()=>el('report-dialog').close());
  el('report-form').addEventListener('submit',e=>{
    e.preventDefault();send('report',{reason:el('report-reason').value});el('report-dialog').close();
  });
  window.addEventListener('beforeunload',()=>{stopMedia();});
  connect();
}
init();
