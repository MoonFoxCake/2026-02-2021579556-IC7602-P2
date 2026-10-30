#ifndef PROXY_H
#define PROXY_H

int proxy_init(void);
void proxy_handle(int client);
const char *proxy_port(void);

#endif
