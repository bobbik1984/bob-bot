package life

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

// RFC 8291 uses one RFC 8188 record. All supported push services accept 4096
// bytes including the 86-byte header, delimiter and authentication tag.
const maxPushPlaintext = 3993

type PushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

func (k PushKeys) decode() (*ecdh.PublicKey, []byte, error) {
	pub, err := web64.DecodeString(k.P256dh)
	if err != nil {
		return nil, nil, errors.New("invalid push public key")
	}
	key, err := ecdh.P256().NewPublicKey(pub)
	if err != nil {
		return nil, nil, errors.New("invalid push public key")
	}
	auth, err := web64.DecodeString(k.Auth)
	if err != nil || len(auth) != 16 {
		return nil, nil, errors.New("invalid push auth secret")
	}
	return key, auth, nil
}

func mac256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func encryptPush(keys PushKeys, plain []byte) ([]byte, error) {
	sender, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err = rand.Read(salt); err != nil {
		return nil, err
	}
	return sealPush(keys, plain, sender, salt)
}

func sealPush(keys PushKeys, plain []byte, sender *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(plain) > maxPushPlaintext || len(salt) != 16 {
		return nil, errors.New("invalid push payload size")
	}
	receiver, auth, err := keys.decode()
	if err != nil {
		return nil, err
	}
	shared, err := sender.ECDH(receiver)
	if err != nil {
		return nil, err
	}
	pub := sender.PublicKey().Bytes()
	info := append([]byte("WebPush: info\x00"), receiver.Bytes()...)
	info = append(info, pub...)
	ikm := mac256(mac256(auth, shared), append(info, 1))
	prk := mac256(salt, ikm)
	cek := mac256(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16]
	nonce := mac256(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12]
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	header := make([]byte, 0, 86+len(plain)+17)
	header = append(header, salt...)
	header = binary.BigEndian.AppendUint32(header, 4096)
	header = append(header, byte(len(pub)))
	header = append(header, pub...)
	record := make([]byte, len(plain)+1)
	copy(record, plain)
	record[len(plain)] = 2
	return gcm.Seal(header, nonce, record, nil), nil
}
