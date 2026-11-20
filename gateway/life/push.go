package life

import (
 "context"
 "crypto/ecdh"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/json"
 "fmt"
 "net/http"
 "math/big"
 "net/url"
 "strings"
 "time"
)

var web64=base64.RawURLEncoding
func makePushKey()(string,error){k,e:=ecdh.P256().GenerateKey(rand.Reader);if e!=nil{return "",e};return web64.EncodeToString(k.Bytes()),nil}
func pushPrivate(s string)(*ecdsa.PrivateKey,error){
 raw,e:=web64.DecodeString(s);if e!=nil{return nil,e}
 k,e:=ecdh.P256().NewPrivateKey(raw);if e!=nil{return nil,e}
 pub:=k.PublicKey().Bytes();x,y:=elliptic.Unmarshal(elliptic.P256(),pub)
 key:=new(ecdsa.PrivateKey);key.Curve=elliptic.P256();key.X,key.Y=x,y;key.D=new(big.Int).SetBytes(raw)
 return key,nil
}
func pushURL(s string)(*url.URL,bool){
 u,e:=url.Parse(s);if e!=nil||u.Scheme!="https"||u.User!=nil||u.Port()!=""||u.Fragment!=""||len(s)>3000{return nil,false}
 h:=strings.ToLower(u.Hostname())
 ok:=h=="fcm.googleapis.com"||h=="web.push.apple.com"||h=="updates.push.services.mozilla.com"||strings.HasSuffix(h,".push.services.mozilla.com")||strings.HasSuffix(h,".notify.windows.com")
 return u,ok
}
var pushClient=&http.Client{Timeout:10*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
func sendWake(ctx context.Context,endpoint,secret,topic string)(int,error){
 u,ok:=pushURL(endpoint);if !ok{return 400,fmt.Errorf("unsupported push endpoint")}
 priv,e:=pushPrivate(secret);if e!=nil{return 0,e}
 claim,_:=json.Marshal(map[string]any{"aud":"https://"+u.Host,"exp":time.Now().Add(time.Hour).Unix(),"sub":"https://bot.bobbik.org"})
 unsigned:=web64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))+"."+web64.EncodeToString(claim)
 h:=sha256.Sum256([]byte(unsigned));r,s,e:=ecdsa.Sign(rand.Reader,priv,h[:]);if e!=nil{return 0,e}
 sig:=append(r.FillBytes(make([]byte,32)),s.FillBytes(make([]byte,32))...)
 key:=elliptic.Marshal(elliptic.P256(),priv.X,priv.Y)
 req,e:=http.NewRequestWithContext(ctx,"POST",endpoint,http.NoBody);if e!=nil{return 0,e}
 req.Header.Set("Authorization","vapid t="+unsigned+"."+web64.EncodeToString(sig)+", k="+web64.EncodeToString(key))
 req.Header.Set("TTL","1800");req.Header.Set("Topic",topic)
 res,e:=pushClient.Do(req);if e!=nil{return 0,e};defer res.Body.Close();return res.StatusCode,nil
}
func(a *App)tick(ctx context.Context){
 a.mu.Lock();next:=a.copy()
 if refresh(&next,a.now()){if a.save(next)!=nil{a.mu.Unlock();return}}
 a.mu.Unlock()
 // Store one receipt per device + item, so resolving a second item never replays the first.
 for endpoint:=range next.Subs{
  if strings.Contains(endpoint,"\n"){continue}
  for _,i:=range next.Items{
   if i.Signal==""||i.Seen==i.Signal{continue}
   receipt:=endpoint+"\n"+i.ID;if next.Subs[receipt]==i.Signal{continue}
   code,e:=sendWake(ctx,endpoint,next.Key,i.ID);if e!=nil{break}
   a.mu.Lock();s:=a.copy();_,subscribed:=s.Subs[endpoint]
   if subscribed && (code==404||code==410){forgetDevice(s.Subs,endpoint);a.save(s)} else if subscribed&&code>=200&&code<300{s.Subs[receipt]=i.Signal;a.save(s)}
   a.mu.Unlock();if code<200||code>=300{break}
  }
 }
}
func forgetDevice(subs map[string]string,endpoint string){delete(subs,endpoint);for k:=range subs{if strings.HasPrefix(k,endpoint+"\n"){delete(subs,k)}}}
