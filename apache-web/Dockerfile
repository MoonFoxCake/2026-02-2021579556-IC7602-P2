FROM httpd:2.4-alpine
RUN sed -i 's/^Listen 80$/Listen 8080/' /usr/local/apache2/conf/httpd.conf \
    && sed -i 's|^#PidFile logs/httpd.pid|PidFile /tmp/httpd.pid|' /usr/local/apache2/conf/httpd.conf \
    && chown -R 10001:0 /usr/local/apache2/logs
COPY --chown=10001:0 index.html /usr/local/apache2/htdocs/index.html
USER 10001
EXPOSE 8080
