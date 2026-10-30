#include "proxy.h"

#include <errno.h>
#include <netdb.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void)
{
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM,
                             .ai_flags = AI_PASSIVE}, *addresses;
    int listener = -1, one = 1, active = 0;
    struct sigaction action = {.sa_handler = SIG_IGN};

    sigemptyset(&action.sa_mask);
    if (sigaction(SIGPIPE, &action, NULL) || proxy_init() < 0)
        return EXIT_FAILURE;
    int error = getaddrinfo(NULL, proxy_port(), &hints, &addresses);
    if (error) {
        fprintf(stderr, "listen: %s\n", gai_strerror(error));
        return EXIT_FAILURE;
    }
    for (struct addrinfo *a = addresses; a; a = a->ai_next) {
        listener = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (listener < 0)
            continue;
        if (!setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one) &&
            !bind(listener, a->ai_addr, a->ai_addrlen) && !listen(listener, 128))
            break;
        close(listener);
        listener = -1;
    }
    freeaddrinfo(addresses);
    if (listener < 0) {
        perror("listen");
        return EXIT_FAILURE;
    }
    fprintf(stderr, "zonal-cache listening on %s\n", proxy_port());
    for (;;) {
        while (waitpid(-1, NULL, WNOHANG) > 0)
            active--;
        /* Bound processes and request buffers even when clients stall. */
        if (active == 32) {
            if (waitpid(-1, NULL, 0) < 0) {
                if (errno == EINTR)
                    continue;
                perror("waitpid");
                return EXIT_FAILURE;
            }
            active--;
        }
        int client = accept(listener, NULL, NULL);
        if (client < 0) {
            if (errno == EINTR)
                continue;
            perror("accept");
            return EXIT_FAILURE;
        }
        pid_t pid = fork();
        if (pid == 0) {
            close(listener);
            proxy_handle(client);
            close(client);
            _exit(EXIT_SUCCESS);
        }
        if (pid < 0)
            perror("fork");
        else
            active++;
        close(client);
    }
}
