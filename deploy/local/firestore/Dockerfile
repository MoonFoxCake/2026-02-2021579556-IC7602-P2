FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:573.0.0-emulators
COPY start.sh /usr/local/bin/start-firestore
RUN sed -i 's/\r$//' /usr/local/bin/start-firestore && chmod +x /usr/local/bin/start-firestore
ENTRYPOINT ["/usr/local/bin/start-firestore"]
