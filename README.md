### asterisk

a global, fast, customizable real-time chatting app.

### self-host

this assumes you have a linux machine avaliable, and with a debian or ubuntu based distro. currently a debian/ubuntu based distro is supported.

first, fork the repository:

```
git clone https://github.com/auth1ery/asterisk.git
```
> [!NOTE]
> make sure you have git installed!

and cd to the folder:

```
cd asterisk
cd backend
```
then install dependencies...

```
npm install
```
> [!NOTE]
> make sure you have NPM installed

once you've installed the dependencies, lets install the cloudflared service (systemd)

```
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```
once you've installed cloudflared (which is cloudflare tunnel), authenticate the system service:

```
cloudflared tunnel login
```
then install it as a system service:

```
sudo cloudflared service install
```
then finally, start the service:

```
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

once you've installed the cloudflare tunnel, lets start up the backend service (assuming you're still in /asterisk/backend)

start the service:

```
pm2 start server.js --name asterisk
pm2 save
```
> [!NOTE]
> this assumes you have pm2 installed!

wait 10 seconds, and go check if it's errored

```
pm2 list
```
if it still says "online" everything is good. if it says "errored" you might have not installed all the dependencies correctly, try running `npm install` agaian.

there you go! your own asterisk is ready to go! either connect your cloudflare pages site to the cloudflare tunnel, or just go to the localhost link provided.
